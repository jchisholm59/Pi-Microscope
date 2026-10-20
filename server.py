#!/usr/bin/env python3
"""Pi-Microscope: a web microscope for a Raspberry Pi HQ camera (IMX477) on a microscope.

One process owns the camera (picamera2) and serves the browser app (aiohttp):
  /stream.mjpg      live view (hardware MJPEG from the preview stream; ?fps= to throttle)
  /ws               controls, stats (exposure, white balance, focus metric, histogram), jobs
  /api/...          gallery, calibrations, snapshot
Captures: quick (2 MP from the stream, no interruption), full (12 MP, optional DNG raw), focus stacks, video
(H.264 MP4), time-lapse (frames + MP4). Measurements are calibrated in micrometres per sensor pixel, so they stay
right at any digital zoom and any capture size.
Config: PORT (8075), DATA_DIR (./data).
"""
import asyncio
import io
import json
import os
import threading
import time
import traceback
from datetime import datetime

import cv2
import numpy as np
from aiohttp import web, WSMsgType
from libcamera import Transform
from picamera2 import Picamera2
from picamera2.encoders import H264Encoder, MJPEGEncoder, Quality
from picamera2.outputs import FileOutput, PyavOutput

import stack as stacker

PORT = int(os.environ.get('PORT', 8075))
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('DATA_DIR', os.path.join(HERE, 'data'))
IMG = os.path.join(DATA, 'images')
THUMB = os.path.join(DATA, 'thumbs')
for d in (DATA, IMG, THUMB):
    os.makedirs(d, exist_ok=True)

SENSOR = (4056, 3040)   # IMX477 full array
MAIN = (2028, 1520)     # 2x2 binned, full field of view: frames for quick captures, stacking, white balance
LORES = (1352, 1014)    # preview / video stream (hardware MJPEG and H.264)


def log(*a):
    print(datetime.now().isoformat(timespec='seconds'), *a, flush=True)


def load(name, default):
    try:
        with open(os.path.join(DATA, name)) as f:
            return json.load(f)
    except Exception:
        return default


def save(name, obj):
    p = os.path.join(DATA, name)
    with open(p + '.tmp', 'w') as f:
        json.dump(obj, f, indent=1)
    os.replace(p + '.tmp', p)


DEFAULTS = {
    'ae': True, 'ev': 0.0, 'metering': 0, 'exposure': 10000, 'gain': 1.0,
    'awb': True, 'awbMode': 0, 'gains': [2.0, 1.6],
    'brightness': 0.0, 'contrast': 1.0, 'saturation': 1.0, 'sharpness': 1.0, 'denoise': 1,
    'hflip': False, 'vflip': False, 'fps': 30, 'quality': 'HIGH',
    'crop': [0.0, 0.0, 1.0, 1.0],   # normalised x, y, w, h of the sensor
    'roi': [0.3, 0.3, 0.4, 0.4],    # focus-metric region (normalised view coordinates)
    'calibration': None,
}


# ---- live MJPEG frames ----------------------------------------------------------------------------------------------
class Frames(io.BufferedIOBase):
    """The MJPEG encoder writes each JPEG here; HTTP clients pick up the newest."""

    def __init__(self):
        self.frame = None
        self.seq = 0
        self.t = 0

    def write(self, buf):
        self.frame = bytes(buf)
        self.seq += 1
        self.t = time.time()
        return len(buf)


# ---- camera ---------------------------------------------------------------------------------------------------------
class Camera:
    def __init__(self, hub):
        self.hub = hub
        self.lock = threading.RLock()
        self.s = {**DEFAULTS, **load('settings.json', {})}
        self.frames = Frames()
        self.p = Picamera2()
        self.mjpeg = None
        self.video = None          # (encoder, path, t0)
        self.busy = False          # reconfiguring / full-res capture: stats pause
        self.meta = {}
        self.stats = {}
        self.start()
        threading.Thread(target=self.stats_loop, daemon=True).start()

    # settings -> libcamera controls
    def controls(self):
        s = self.s
        frame_us = int(1e6 / max(1, min(50, s['fps'])))
        c = {
            'Brightness': float(s['brightness']), 'Contrast': float(s['contrast']), 'Saturation': float(s['saturation']),
            'Sharpness': float(s['sharpness']), 'NoiseReductionMode': int(s['denoise']), 'ScalerCrop': self.scaler_crop(),
        }
        if s['ae']:
            c.update({'AeEnable': True, 'ExposureTimeMode': 0, 'AnalogueGainMode': 0, 'ExposureValue': float(s['ev']),
                      'AeMeteringMode': int(s['metering']), 'FrameDurationLimits': (frame_us, frame_us)})
        else:
            exp = int(max(100, s['exposure']))
            c.update({'AeEnable': False, 'ExposureTimeMode': 1, 'AnalogueGainMode': 1, 'ExposureTime': exp,
                      'AnalogueGain': float(max(1.0, min(22.0, s['gain']))),
                      'FrameDurationLimits': (frame_us, max(frame_us, exp + 1000))})
        if s['awb']:
            c.update({'AwbEnable': True, 'AwbMode': int(s['awbMode'])})
        else:
            c.update({'AwbEnable': False, 'ColourGains': (float(s['gains'][0]), float(s['gains'][1]))})
        return c

    def scaler_crop(self):
        x, y, w, h = self.s['crop']
        W, H = SENSOR
        w = max(64 / W, min(1.0, w))
        h = max(64 / H, min(1.0, h))
        x = max(0.0, min(1.0 - w, x))
        y = max(0.0, min(1.0 - h, y))
        return (int(x * W) & ~1, int(y * H) & ~1, int(w * W) & ~1, int(h * H) & ~1)

    def transform(self):
        return Transform(hflip=bool(self.s['hflip']), vflip=bool(self.s['vflip']))

    def start(self):
        with self.lock:
            cfg = self.p.create_video_configuration(main={'size': MAIN, 'format': 'RGB888'}, lores={'size': LORES},
                                                    raw={'size': MAIN}, buffer_count=6, transform=self.transform(),
                                                    controls=self.controls())
            self.p.configure(cfg)
            self.p.start()
            self.mjpeg = MJPEGEncoder()
            self.p.start_encoder(self.mjpeg, FileOutput(self.frames), name='lores', quality=getattr(Quality, self.s['quality'], Quality.HIGH))

    def restart(self):
        with self.lock:
            self.busy = True
            try:
                self.stop_video()
                try:
                    self.p.stop_encoder(self.mjpeg)
                except Exception:
                    pass
                self.p.stop()
                self.start()
            finally:
                self.busy = False

    def apply(self, ch):
        """Change settings: most are live controls; flips and stream quality need a restart."""
        restart = False
        with self.lock:
            for k, v in ch.items():
                if k not in DEFAULTS:
                    continue
                if k in ('hflip', 'vflip', 'quality') and self.s[k] != v:
                    restart = True
                self.s[k] = v
            save('settings.json', self.s)
            if restart:
                self.restart()
            else:
                self.p.set_controls(self.controls())

    def white_balance(self, rect):
        """Make the selected area neutral grey: read its colour from the main stream and adjust the colour gains."""
        with self.lock:
            md = self.p.capture_metadata()
            r_g, b_g = md.get('ColourGains', tuple(self.s['gains']))
            for _ in range(3):
                img = self.p.capture_array('main')  # BGR
                h, w = img.shape[:2]
                x0, y0 = int(rect[0] * w), int(rect[1] * h)
                x1, y1 = max(x0 + 4, int((rect[0] + rect[2]) * w)), max(y0 + 4, int((rect[1] + rect[3]) * h))
                b, g, r = img[y0:y1, x0:x1].reshape(-1, 3).astype(np.float64).mean(0)
                if min(b, g, r) < 4 or max(b, g, r) > 250:
                    return False, 'pick an area that is neither black nor blown out'
                r_g = float(np.clip(r_g * g / r, 0.3, 8.0))
                b_g = float(np.clip(b_g * g / b, 0.3, 8.0))
                self.s.update({'awb': False, 'gains': [round(r_g, 3), round(b_g, 3)]})
                self.p.set_controls(self.controls())
                time.sleep(0.35)
            save('settings.json', self.s)
            return True, f'white balance set (red {r_g:.2f}, blue {b_g:.2f})'

    # ---- calibration from a ruler: the tick period along a drawn line ----
    def autocal(self, pts, tick_mm, image_id=None):
        """pts: two points in sensor-normalised (live) or image-normalised (picture) units along the ruler scale.
        Samples the brightness along the line (averaged across a few pixels), removes the slow trend and takes the
        strongest period from an FFT (refined between bins). Returns micrometres per sensor pixel."""
        if image_id:
            meta = read_meta(image_id)
            img = cv2.imread(os.path.join(IMG, meta['file']))
            H, W = img.shape[:2]
            P = [(p[0] * W, p[1] * H) for p in pts]
            sensor_per_px = meta['crop'][2] / W
        else:
            img = self.p.capture_array('main')
            H, W = img.shape[:2]
            cx, cy, cw, ch = [v / SENSOR[i % 2] for i, v in enumerate(self.scaler_crop())]
            P = [((p[0] - cx) / cw * W, (p[1] - cy) / ch * H) for p in pts]
            sensor_per_px = cw * SENSOR[0] / W
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
        (x0, y0), (x1, y1) = P
        L = float(np.hypot(x1 - x0, y1 - y0))
        n = int(L)
        if n < 40:
            return {'ok': False, 'msg': 'line too short'}
        t = np.linspace(0, 1, n)
        ux, uy = (x1 - x0) / L, (y1 - y0) / L
        prof = np.zeros(n, np.float32)
        for off in range(-3, 4):  # average a 7-pixel-wide strip
            mx = (x0 + t * (x1 - x0) - uy * off).astype(np.float32)
            my = (y0 + t * (y1 - y0) + ux * off).astype(np.float32)
            prof += cv2.remap(gray, mx.reshape(1, -1), my.reshape(1, -1), cv2.INTER_LINEAR).ravel()
        win = max(9, n // 12) | 1
        trend = np.convolve(prof, np.ones(win) / win, mode='same')
        x = (prof - trend) * np.hanning(n)
        spec = np.abs(np.fft.rfft(x))
        lo, hi = 3, min(len(spec) - 2, n // 3)
        if hi <= lo:
            return {'ok': False, 'msg': 'line too short'}
        k = lo + int(np.argmax(spec[lo:hi]))
        a, b, c = spec[k - 1], spec[k], spec[k + 1]
        kf = k + (0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0)
        period = n / kf
        conf = float(b / (np.median(spec[lo:hi]) + 1e-9))
        ticks = n / period
        um = tick_mm * 1000 / (period * sensor_per_px)
        ok = conf > 4 and ticks >= 3
        return {'ok': bool(ok), 'umPerPx': float(um), 'periodPx': float(period), 'ticks': float(ticks), 'confidence': conf,
                'msg': None if ok else f'no clear tick pattern (confidence {conf:.1f}, {ticks:.1f} ticks)'}

    # ---- stats: exposure, white balance, focus metric, histogram ----
    def stats_loop(self):
        hist_t = 0
        while True:
            try:
                if self.busy:
                    time.sleep(0.1)
                    continue
                md = self.p.capture_metadata()
                yuv = self.p.capture_array('lores')
                y = yuv[:LORES[1], :LORES[0]]
                rx, ry, rw, rh = self.s['roi']
                h, w = y.shape
                roi = y[int(ry * h):int((ry + rh) * h), int(rx * w):int((rx + rw) * w)]
                focus = stacker.frame_sharpness(roi) if roi.size > 100 else 0.0
                st = {
                    'type': 'stats', 'exposure': md.get('ExposureTime'), 'gain': round(md.get('AnalogueGain', 0), 2),
                    'dgain': round(md.get('DigitalGain', 0), 2), 'ct': md.get('ColourTemperature'),
                    'gains': [round(v, 3) for v in md.get('ColourGains', (0, 0))], 'lux': round(md.get('Lux', 0)),
                    'fom': md.get('FocusFoM'), 'focus': round(focus, 1), 'temp': md.get('SensorTemperature'),
                    'frameDur': md.get('FrameDuration'), 'crop': list(md.get('ScalerCrop', self.scaler_crop())),
                    'clip': round(float((y[::4, ::4] >= 250).mean() * 100), 2), 'dark': round(float((y[::4, ::4] <= 5).mean() * 100), 2),
                    'video': bool(self.video), 'videoSec': round(time.time() - self.video[2], 1) if self.video else 0,
                }
                if time.time() - hist_t > 0.5:
                    st['hist'] = np.bincount((y[::4, ::4] >> 2).ravel(), minlength=64).tolist()
                    hist_t = time.time()
                self.stats = st
                self.hub.broadcast(st)
            except Exception as e:
                if not self.busy:
                    log('stats:', e)
                time.sleep(0.5)
            time.sleep(0.2)

    # ---- captures ----
    def new_id(self, kind):
        return datetime.now().strftime('%Y%m%d-%H%M%S-') + f'{int(time.time() * 1000) % 1000:03d}-{kind}'

    def save_image(self, img, kind, extra=None, sensor_crop=None):
        """Save a BGR image to the gallery with its metadata and a thumbnail; returns the metadata."""
        iid = self.new_id(kind)
        path = os.path.join(IMG, iid + '.jpg')
        cv2.imwrite(path, img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        h, w = img.shape[:2]
        crop = sensor_crop or self.scaler_crop()
        cal = self.hub.calibration()
        meta = {
            'id': iid, 'file': iid + '.jpg', 'kind': kind, 't': time.time(), 'w': w, 'h': h, 'crop': list(crop),
            # micrometres per pixel of this image: calibration is per sensor pixel, the image spans crop[2] sensor px
            'umPerPx': cal['umPerPx'] * crop[2] / w if cal else None, 'calibration': cal['name'] if cal else None,
            'exposure': self.stats.get('exposure'), 'gain': self.stats.get('gain'), 'note': '', 'measurements': [],
            'settings': {k: self.s[k] for k in ('ae', 'ev', 'awb', 'gains', 'contrast', 'saturation', 'sharpness', 'hflip', 'vflip')},
            **(extra or {}),
        }
        t = cv2.resize(img, (320, int(320 * h / w)), interpolation=cv2.INTER_AREA)
        cv2.imwrite(os.path.join(THUMB, iid + '.jpg'), t, [cv2.IMWRITE_JPEG_QUALITY, 80])
        with open(os.path.join(IMG, iid + '.json'), 'w') as f:
            json.dump(meta, f)
        return meta

    def capture(self, full=False, dng=False):
        if not full:
            img = self.p.capture_array('main')
            return self.save_image(img, 'snap')
        # 12 MP: pause the preview, switch to the full-resolution mode for one frame, switch back
        with self.lock:
            self.busy = True
            try:
                self.stop_video()
                self.p.stop_encoder(self.mjpeg)
                cfg = self.p.create_still_configuration(main={'size': SENSOR, 'format': 'RGB888'}, raw={'size': SENSOR},
                                                        transform=self.transform(), controls=self.controls(), buffer_count=1)
                req = self.p.switch_mode_and_capture_request(cfg)
                try:
                    img = req.make_array('main')
                    extra = {}
                    if dng:
                        iid_dng = self.new_id('raw')
                        req.save_dng(os.path.join(IMG, iid_dng + '.dng'))
                        extra['dng'] = iid_dng + '.dng'
                finally:
                    req.release()
                self.mjpeg = MJPEGEncoder()
                self.p.start_encoder(self.mjpeg, FileOutput(self.frames), name='lores', quality=getattr(Quality, self.s['quality'], Quality.HIGH))
            finally:
                self.busy = False
        return self.save_image(img, 'full', extra)

    # ---- video ----
    def start_video(self):
        with self.lock:
            if self.video:
                return None
            iid = self.new_id('video')
            path = os.path.join(IMG, iid + '.mp4')
            enc = H264Encoder(bitrate=12_000_000, repeat=True, iperiod=30)
            self.p.start_encoder(enc, PyavOutput(path), name='lores')
            self.video = (enc, path, time.time(), iid)
            return iid

    def stop_video(self):
        with self.lock:
            if not self.video:
                return None
            enc, path, t0, iid = self.video
            self.video = None
            try:
                self.p.stop_encoder(enc)
            except Exception as e:
                log('stop video:', e)
            # thumbnail from the stream and a metadata file so the gallery lists it
            try:
                img = self.p.capture_array('main')
                t = cv2.resize(img, (320, 240), interpolation=cv2.INTER_AREA)
                cv2.imwrite(os.path.join(THUMB, iid + '.jpg'), t)
            except Exception:
                pass
            meta = {'id': iid, 'file': iid + '.mp4', 'kind': 'video', 't': t0, 'dur': round(time.time() - t0, 1), 'w': LORES[0], 'h': LORES[1], 'note': '', 'measurements': []}
            with open(os.path.join(IMG, iid + '.json'), 'w') as f:
                json.dump(meta, f)
            return meta


# ---- background jobs: focus stack, time-lapse -------------------------------------------------------------------------
class StackJob:
    """Collect frames while the user turns the focus knob, then fuse them."""

    def __init__(self, hub, cam, max_frames=48):
        self.hub, self.cam, self.max = hub, cam, max_frames
        self.frames, self.state, self.stop_flag = [], 'capturing', False
        self.last_focus, self.last_t = None, 0
        threading.Thread(target=self.capture_loop, daemon=True).start()

    def capture_loop(self):
        while not self.stop_flag and len(self.frames) < self.max:
            try:
                img = self.cam.p.capture_array('main')
                small = cv2.cvtColor(cv2.resize(img, (507, 380), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
                f = stacker.frame_sharpness(small)
                # keep a frame when the focus has moved (sharpness changed by 4 %) or every 1.5 s regardless
                if self.last_focus is None or abs(f - self.last_focus) / max(self.last_focus, 1e-6) > 0.04 or time.time() - self.last_t > 1.5:
                    self.frames.append(img)
                    self.last_focus, self.last_t = f, time.time()
                    self.hub.broadcast({'type': 'job', 'job': 'stack', 'state': 'capturing', 'frames': len(self.frames), 'max': self.max})
            except Exception as e:
                log('stack capture:', e)
                time.sleep(0.2)
            time.sleep(0.12)
        if len(self.frames) >= self.max:
            self.hub.broadcast({'type': 'toast', 'msg': f'Stack: {self.max} frames collected, press Fuse'})

    def finish(self):
        self.stop_flag = True
        if len(self.frames) < 2:
            self.state = 'idle'
            return self.hub.broadcast({'type': 'job', 'job': 'stack', 'state': 'idle', 'msg': 'Need at least 2 frames'})
        self.state = 'processing'
        threading.Thread(target=self.process, daemon=True).start()

    def process(self):
        try:
            t0 = time.time()
            prog = lambda i, n: self.hub.broadcast({'type': 'job', 'job': 'stack', 'state': 'processing', 'i': i, 'n': n})
            out, depth, info = stacker.stack(self.frames, progress=prog)
            meta = self.cam.save_image(out, 'stack', {'frames': info['frames'], 'aligned': info['aligned'], 'took': round(time.time() - t0, 1)})
            dpath = os.path.join(IMG, meta['id'] + '-depth.png')
            cv2.imwrite(dpath, cv2.applyColorMap(depth, cv2.COLORMAP_TURBO))
            meta['depth'] = os.path.basename(dpath)
            with open(os.path.join(IMG, meta['id'] + '.json'), 'w') as f:
                json.dump(meta, f)
            self.hub.broadcast({'type': 'job', 'job': 'stack', 'state': 'done', 'image': meta})
            self.hub.broadcast({'type': 'image', 'image': meta})
        except Exception as e:
            traceback.print_exc()
            self.hub.broadcast({'type': 'job', 'job': 'stack', 'state': 'error', 'msg': str(e)})
        finally:
            self.frames = []
            self.state = 'idle'


class TimelapseJob:
    def __init__(self, hub, cam, interval, count, full):
        self.hub, self.cam = hub, cam
        self.interval, self.count, self.full = max(1.0, interval), count, full
        self.n, self.stop_flag = 0, False
        self.id = cam.new_id('timelapse')
        self.dir = os.path.join(IMG, self.id)
        os.makedirs(self.dir)
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        t = time.time()
        while not self.stop_flag and (not self.count or self.n < self.count):
            try:
                if self.full:
                    meta = self.cam.capture(full=True)
                    img = cv2.imread(os.path.join(IMG, meta['file']))
                    for ext in ('.jpg', '.json'):
                        os.remove(os.path.join(IMG, meta['id'] + ext))
                    os.remove(os.path.join(THUMB, meta['id'] + '.jpg'))
                else:
                    img = self.cam.p.capture_array('main')
                self.n += 1
                cv2.imwrite(os.path.join(self.dir, f'{self.n:05d}.jpg'), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
                self.hub.broadcast({'type': 'job', 'job': 'timelapse', 'state': 'running', 'n': self.n, 'count': self.count, 'next': t + self.interval})
            except Exception as e:
                log('timelapse:', e)
            t += self.interval
            while not self.stop_flag and time.time() < t:
                time.sleep(0.1)
        self.make_video()

    def make_video(self):
        import av
        files = sorted(f for f in os.listdir(self.dir) if f.endswith('.jpg'))
        if not files:
            return self.hub.broadcast({'type': 'job', 'job': 'timelapse', 'state': 'idle'})
        self.hub.broadcast({'type': 'job', 'job': 'timelapse', 'state': 'encoding', 'n': len(files)})
        path = os.path.join(IMG, self.id + '.mp4')
        try:
            first = cv2.imread(os.path.join(self.dir, files[0]))
            h, w = first.shape[:2]
            scale = min(1.0, 1920 / w)
            W, H = int(w * scale) & ~1, int(h * scale) & ~1
            with av.open(path, 'w') as out:
                st = out.add_stream('h264', rate=15)
                st.width, st.height, st.pix_fmt = W, H, 'yuv420p'
                st.options = {'crf': '20', 'preset': 'veryfast'}
                for f in files:
                    img = cv2.resize(cv2.imread(os.path.join(self.dir, f)), (W, H), interpolation=cv2.INTER_AREA)
                    frame = av.VideoFrame.from_ndarray(img, format='bgr24')
                    for pkt in st.encode(frame):
                        out.mux(pkt)
                for pkt in st.encode():
                    out.mux(pkt)
            cv2.imwrite(os.path.join(THUMB, self.id + '.jpg'), cv2.resize(first, (320, int(320 * h / w))))
            meta = {'id': self.id, 'file': self.id + '.mp4', 'kind': 'timelapse', 't': time.time(), 'frames': len(files),
                    'interval': self.interval, 'folder': self.id, 'w': W, 'h': H, 'note': '', 'measurements': []}
            with open(os.path.join(IMG, self.id + '.json'), 'w') as f:
                json.dump(meta, f)
            self.hub.broadcast({'type': 'image', 'image': meta})
            self.hub.broadcast({'type': 'job', 'job': 'timelapse', 'state': 'done', 'n': len(files)})
        except Exception as e:
            traceback.print_exc()
            self.hub.broadcast({'type': 'job', 'job': 'timelapse', 'state': 'error', 'msg': str(e)})


# ---- hub: websocket clients, commands, persistence ------------------------------------------------------------------
class Hub:
    def __init__(self):
        self.clients = set()
        self.loop = None
        self.cals = load('calibrations.json', [])     # [{id, name, umPerPx (per sensor pixel)}]
        self.presets = load('presets.json', [])       # [{name, settings}]
        self.cam = Camera(self)
        self.stack = None
        self.timelapse = None

    def calibration(self):
        cid = self.cam.s.get('calibration')
        return next((c for c in self.cals if c['id'] == cid), None)

    def broadcast(self, obj):
        if not self.loop or not self.clients:
            return
        msg = json.dumps(obj)
        self.loop.call_soon_threadsafe(self._send_all, msg)

    def _send_all(self, msg):
        for ws in list(self.clients):
            if not ws.closed:
                asyncio.ensure_future(ws.send_str(msg))

    def state(self):
        return {
            'type': 'state', 'settings': self.cam.s, 'calibrations': self.cals, 'calibration': self.calibration(), 'presets': self.presets,
            'sensor': SENSOR, 'main': MAIN, 'lores': LORES,
            'jobs': {'stack': self.stack.state if self.stack else 'idle', 'stackFrames': len(self.stack.frames) if self.stack else 0,
                     'timelapse': bool(self.timelapse and not self.timelapse.stop_flag), 'video': bool(self.cam.video)},
        }

    async def command(self, ws, m):
        c = m.get('cmd')
        cam = self.cam
        run = lambda f, *a: asyncio.get_running_loop().run_in_executor(None, f, *a)
        reply = lambda o: ws.send_str(json.dumps(o))
        if c == 'set':
            await run(cam.apply, {k: v for k, v in m.items() if k != 'cmd'})
        elif c == 'wb':
            ok, msg = await run(cam.white_balance, m['rect'])
            await reply({'type': 'toast', 'msg': msg, 'error': not ok})
        elif c == 'reset':
            await run(cam.apply, {k: v for k, v in DEFAULTS.items() if k not in ('calibration', 'roi')})
        elif c == 'capture':
            meta = await run(cam.capture, bool(m.get('full')), bool(m.get('dng')))
            self.broadcast({'type': 'image', 'image': meta})
            await reply({'type': 'reply', 'reqId': m['reqId'], 'image': meta} if m.get('reqId') else {'type': 'captured', 'image': meta})
        elif c == 'autocal':
            res = await run(cam.autocal, m['pts'], float(m.get('tickMm', 1)), m.get('id'))
            await reply({'type': 'reply', 'reqId': m.get('reqId'), **res})
        elif c == 'videoStart':
            await run(cam.start_video)
        elif c == 'videoStop':
            meta = await run(cam.stop_video)
            if meta:
                self.broadcast({'type': 'image', 'image': meta})
        elif c == 'stackStart':
            if not self.stack or self.stack.state == 'idle':
                self.stack = StackJob(self, cam, int(m.get('max', 48)))
        elif c == 'stackFinish':
            if self.stack and self.stack.state == 'capturing':
                self.stack.finish()
        elif c == 'stackCancel':
            if self.stack:
                self.stack.stop_flag = True
                self.stack.frames = []
                self.stack.state = 'idle'
                self.broadcast({'type': 'job', 'job': 'stack', 'state': 'idle'})
        elif c == 'tlStart':
            if not self.timelapse or self.timelapse.stop_flag:
                self.timelapse = TimelapseJob(self, cam, float(m.get('interval', 10)), int(m.get('count', 0)), bool(m.get('full')))
        elif c == 'tlStop':
            if self.timelapse:
                self.timelapse.stop_flag = True
        elif c == 'calSave':
            cal = {'id': m.get('id') or f'c{int(time.time())}', 'name': str(m.get('name', 'Calibration'))[:40], 'umPerPx': float(m['umPerPx'])}
            self.cals = [x for x in self.cals if x['id'] != cal['id']] + [cal]
            save('calibrations.json', self.cals)
            await run(cam.apply, {'calibration': cal['id']})
        elif c == 'calSelect':
            await run(cam.apply, {'calibration': m.get('id')})
        elif c == 'calDelete':
            self.cals = [x for x in self.cals if x['id'] != m.get('id')]
            save('calibrations.json', self.cals)
            if cam.s.get('calibration') == m.get('id'):
                await run(cam.apply, {'calibration': None})
        elif c == 'presetSave':
            keep = ('ae', 'ev', 'metering', 'exposure', 'gain', 'awb', 'awbMode', 'gains', 'brightness', 'contrast', 'saturation', 'sharpness', 'denoise', 'hflip', 'vflip')
            p = {'name': str(m.get('name', 'Preset'))[:40], 'settings': {k: cam.s[k] for k in keep}}
            self.presets = [x for x in self.presets if x['name'] != p['name']] + [p]
            save('presets.json', self.presets)
        elif c == 'presetLoad':
            p = next((x for x in self.presets if x['name'] == m.get('name')), None)
            if p:
                await run(cam.apply, p['settings'])
        elif c == 'presetDelete':
            self.presets = [x for x in self.presets if x['name'] != m.get('name')]
            save('presets.json', self.presets)
        elif c == 'imgDelete':
            iid = os.path.basename(str(m.get('id')))
            meta = read_meta(iid)
            if meta:
                for f in [meta.get('file'), iid + '.json', meta.get('dng'), meta.get('depth'), iid + '-annotated.jpg']:
                    if f:
                        try:
                            os.remove(os.path.join(IMG, f))
                        except FileNotFoundError:
                            pass
                try:
                    os.remove(os.path.join(THUMB, iid + '.jpg'))
                except FileNotFoundError:
                    pass
                if meta.get('folder'):
                    import shutil
                    shutil.rmtree(os.path.join(IMG, meta['folder']), ignore_errors=True)
            self.broadcast({'type': 'deleted', 'id': iid})
        elif c == 'imgUpdate':
            iid = os.path.basename(str(m.get('id')))
            meta = read_meta(iid)
            if meta:
                for k in ('note', 'measurements', 'title'):
                    if k in m:
                        meta[k] = m[k]
                with open(os.path.join(IMG, iid + '.json'), 'w') as f:
                    json.dump(meta, f)
                self.broadcast({'type': 'image', 'image': meta})
        self.broadcast(self.state())


def read_meta(iid):
    try:
        with open(os.path.join(IMG, iid + '.json')) as f:
            return json.load(f)
    except Exception:
        return None


def list_images():
    out = []
    for f in os.listdir(IMG):
        if f.endswith('.json'):
            m = read_meta(f[:-5])
            if m:
                m['annotated'] = os.path.exists(os.path.join(IMG, m['id'] + '-annotated.jpg'))
                out.append(m)
    return sorted(out, key=lambda m: m['t'], reverse=True)


# ---- HTTP -----------------------------------------------------------------------------------------------------------
hub = None


async def stream(request):
    """multipart MJPEG: the newest frame each time one arrives (slow clients skip frames, never lag)."""
    fps = float(request.query.get('fps', 0) or 0)
    resp = web.StreamResponse(headers={'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-cache', 'Pragma': 'no-cache'})
    await resp.prepare(request)
    fr = hub.cam.frames
    seq, last = -1, 0
    try:
        while True:
            if fr.seq == seq or (fps and time.time() - last < 1 / fps):
                await asyncio.sleep(0.008)
                continue
            seq, last, data = fr.seq, time.time(), fr.frame
            await resp.write(b'--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + str(len(data)).encode() + b'\r\n\r\n' + data + b'\r\n')
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    return resp


async def snapshot(request):
    return web.Response(body=hub.cam.frames.frame or b'', content_type='image/jpeg', headers={'Cache-Control': 'no-cache'})


async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    hub.clients.add(ws)
    await ws.send_str(json.dumps(hub.state()))
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    await hub.command(ws, json.loads(msg.data))
                except Exception as e:
                    traceback.print_exc()
                    await ws.send_str(json.dumps({'type': 'toast', 'msg': str(e), 'error': True}))
    finally:
        hub.clients.discard(ws)
    return ws


async def api_images(request):
    return web.json_response(list_images())


async def api_status(request):
    return web.json_response({'settings': hub.cam.s, 'stats': {k: v for k, v in hub.cam.stats.items() if k != 'hist'}, 'calibration': hub.calibration(),
                              'clients': len(hub.clients), 'images': len([f for f in os.listdir(IMG) if f.endswith('.json')])})


async def api_annotated(request):
    """The browser renders an image with its measurements and uploads the JPEG here."""
    iid = os.path.basename(request.match_info['id'])
    if not read_meta(iid):
        raise web.HTTPNotFound()
    data = await request.read()
    with open(os.path.join(IMG, iid + '-annotated.jpg'), 'wb') as f:
        f.write(data)
    hub.broadcast({'type': 'image', 'image': {**read_meta(iid), 'annotated': True}})
    return web.json_response({'ok': True})


async def index(request):
    return web.FileResponse(os.path.join(HERE, 'web', 'index.html'), headers={'Cache-Control': 'no-cache'})


async def webfile(request):
    name = request.match_info['name']
    path = os.path.join(HERE, 'web', name)
    if '/' in name or not os.path.isfile(path):
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={'Cache-Control': 'no-cache'})


async def on_start(app):
    hub.loop = asyncio.get_running_loop()


def main():
    global hub
    hub = Hub()
    app = web.Application(client_max_size=64 * 1024 * 1024)
    app.on_startup.append(on_start)
    app.router.add_get('/', index)
    app.router.add_get('/stream.mjpg', stream)
    app.router.add_get('/snapshot.jpg', snapshot)
    app.router.add_get('/ws', ws_handler)
    app.router.add_get('/api/images', api_images)
    app.router.add_get('/api/status', api_status)
    app.router.add_post('/api/images/{id}/annotated', api_annotated)
    app.router.add_static('/images/', IMG)
    app.router.add_static('/thumbs/', THUMB)
    app.router.add_get('/{name}', webfile)
    log(f'Pi-Microscope on :{PORT} (data {DATA})')
    web.run_app(app, port=PORT, print=None, access_log=None)


if __name__ == '__main__':
    main()

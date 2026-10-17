package ru.kentovka.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Демка с телефона: системная «Запись экрана» (MediaProjection) → кадры JPEG.
 * Страница забирает последний кадр по адресу /__kandroid_frame и рисует его в canvas — оттуда он идёт кентам как обычный стрим.
 */
public class ScreenService extends Service {
    static volatile byte[] latest = null;
    static volatile int fw = 0, fh = 0;
    static volatile Runnable onEnd = null;
    static volatile boolean running = false;
    private static final String CH = "screen";
    private MediaProjection mp;
    private VirtualDisplay vd;
    private ImageReader ir;
    private HandlerThread ht;
    private long lastFrame = 0;
    private int minGap = 100;

    static void start(Context c, int code, Intent data, int maxSide, int fps) {
        Intent i = new Intent(c, ScreenService.class).putExtra("code", code).putExtra("data", data).putExtra("max", maxSide).putExtra("fps", fps);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }
    static void stop(Context c) { c.stopService(new Intent(c, ScreenService.class)); }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel(CH, "Показ экрана", NotificationManager.IMPORTANCE_LOW));
        PendingIntent stopPi = PendingIntent.getService(this, 1, new Intent(this, ScreenService.class).setAction("stop"), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
        Notification n = b.setSmallIcon(R.drawable.ic_voice).setContentTitle("Кентовка показывает экран").setContentText("Кенты видят твой экран. Нажми, чтобы остановить.")
            .setOngoing(true).setContentIntent(stopPi).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(2, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION); else startForeground(2, n);
        if (intent == null || mp != null) return START_NOT_STICKY;
        try {
            int code = intent.getIntExtra("code", 0);
            Intent data = intent.getParcelableExtra("data");
            int max = intent.getIntExtra("max", 1280);
            int fps = Math.max(2, Math.min(15, intent.getIntExtra("fps", 10)));
            minGap = 1000 / fps;
            ht = new HandlerThread("kentovka-screen"); ht.start();
            Handler h = new Handler(ht.getLooper());
            MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
            mp = mpm.getMediaProjection(code, data);
            mp.registerCallback(new MediaProjection.Callback() { @Override public void onStop() { stopSelf(); } }, h);
            DisplayMetrics dm = new DisplayMetrics();
            ((WindowManager) getSystemService(WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(dm);
            float k = Math.min(1f, (float) max / Math.max(dm.widthPixels, dm.heightPixels));
            int w = Math.max(2, Math.round(dm.widthPixels * k) & ~1), hh = Math.max(2, Math.round(dm.heightPixels * k) & ~1);
            fw = w; fh = hh;
            ir = ImageReader.newInstance(w, hh, PixelFormat.RGBA_8888, 2);
            ir.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                @Override public void onImageAvailable(ImageReader r) {
                    Image img = null;
                    try {
                        img = r.acquireLatestImage(); if (img == null) return;
                        long now = System.currentTimeMillis(); if (now - lastFrame < minGap) return; lastFrame = now;
                        Image.Plane p = img.getPlanes()[0];
                        ByteBuffer buf = p.getBuffer();
                        int ps = p.getPixelStride(), rs = p.getRowStride(), iw = img.getWidth(), ih = img.getHeight();
                        Bitmap bm = Bitmap.createBitmap(iw + (rs - ps * iw) / ps, ih, Bitmap.Config.ARGB_8888);
                        bm.copyPixelsFromBuffer(buf);
                        Bitmap crop = bm.getWidth() == iw ? bm : Bitmap.createBitmap(bm, 0, 0, iw, ih);
                        ByteArrayOutputStream bo = new ByteArrayOutputStream(64 * 1024);
                        crop.compress(Bitmap.CompressFormat.JPEG, 62, bo);
                        latest = bo.toByteArray();
                        if (crop != bm) crop.recycle(); bm.recycle();
                    } catch (Exception ignored) {
                    } finally { if (img != null) img.close(); }
                }
            }, h);
            vd = mp.createVirtualDisplay("kentovka", w, hh, dm.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, ir.getSurface(), null, h);
            running = true;
        } catch (Exception e) { stopSelf(); }
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        running = false;
        try { if (vd != null) vd.release(); } catch (Exception ignored) {}
        try { if (ir != null) ir.close(); } catch (Exception ignored) {}
        try { if (mp != null) mp.stop(); } catch (Exception ignored) {}
        try { if (ht != null) ht.quitSafely(); } catch (Exception ignored) {}
        mp = null; latest = null;
        Runnable r = onEnd; if (r != null) r.run();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent i) { return null; }
}

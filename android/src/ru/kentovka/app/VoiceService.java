package ru.kentovka.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/** Пока ты в голосовом канале — служба с уведомлением: Android не усыпит звук при выключенном экране. */
public class VoiceService extends Service {
    private static final String CH = "voice";
    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifi;
    private static volatile boolean on = false;

    static void start(Context c, String channel) {
        Intent i = new Intent(c, VoiceService.class).putExtra("ch", channel);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
        on = true;
    }
    static void stop(Context c) { if (!on) return; on = false; c.stopService(new Intent(c, VoiceService.class)); }

    @Override public int onStartCommand(Intent intent, int flags, int id) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel(CH, "Голосовой канал", NotificationManager.IMPORTANCE_LOW));
        String ch = intent == null ? "" : intent.getStringExtra("ch");
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
        Notification n = b.setSmallIcon(R.drawable.ic_voice).setContentTitle("Кентовка — ты в голосовом")
            .setContentText(ch == null || ch.isEmpty() ? "Голос подключён" : "Канал «" + ch + "»").setOngoing(true).setContentIntent(open).build();
        if (Build.VERSION.SDK_INT >= 30) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        else startForeground(1, n);
        if (wake == null) {
            try { wake = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kentovka:voice"); wake.acquire(6 * 3600 * 1000L); } catch (Exception ignored) {}
            try { wifi = ((WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE)).createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "kentovka:voice"); wifi.acquire(); } catch (Exception ignored) {}
        }
        return START_NOT_STICKY;
    }
    @Override public void onDestroy() {
        try { if (wake != null && wake.isHeld()) wake.release(); } catch (Exception ignored) {}
        try { if (wifi != null && wifi.isHeld()) wifi.release(); } catch (Exception ignored) {}
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent i) { return null; }
}

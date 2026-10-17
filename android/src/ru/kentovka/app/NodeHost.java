package ru.kentovka.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Внутри приложения работает Node.js (nodejs-mobile) с той же программой, что на ПК:
 * друзья, личка, группы, звонки, файлы, аккаунт, мосты, свои серверы.
 * Java — оболочка: показывает страницы, даёт микрофон, звук, запись экрана, уведомления и файлы.
 */
public class NodeHost {
    static final int PORT = 18444;
    static final String HOME = "http://127.0.0.1:" + PORT;
    private static volatile boolean started = false;
    private static native int startNode(String[] args);

    interface Events { void onEvent(JSONObject ev); }

    static synchronized boolean start(final Context ctx) {
        if (started) return true;
        Log.i("kentovka", "запускаю node");
        try {
            System.loadLibrary("c++_shared");
            System.loadLibrary("node");
            System.loadLibrary("kentovka");
        } catch (Throwable t) { Log.e("kentovka", "node не загрузился", t); return false; }
        final File proj = new File(ctx.getFilesDir(), "nodeproject");
        final File data = new File(ctx.getFilesDir(), "kentovka");
        data.mkdirs();
        Log.i("kentovka", "библиотеки загружены");
        try { unpack(ctx, proj); } catch (Exception e) { Log.e("kentovka", "не распаковать node", e); return false; }
        Log.i("kentovka", "программа распакована: " + proj);
        started = true;
        Thread t = new Thread(null, new Runnable() { public void run() {
            try {
                android.system.Os.setenv("KENTOVKA_ANDROID_PORT", String.valueOf(PORT), true);
                android.system.Os.setenv("HOME", data.getAbsolutePath(), true);
                android.system.Os.setenv("TMPDIR", ctx.getCacheDir().getAbsolutePath(), true);
            } catch (Exception ignored) {}
            Log.i("kentovka", "node стартует");
            int code = startNode(new String[] { "node", new File(proj, "main.js").getAbsolutePath(), data.getAbsolutePath(), new File(proj, "app").getAbsolutePath() });
            Log.e("kentovka", "node завершился: " + code);
        } }, "kentovka-node", 16 * 1024 * 1024);
        t.start();
        return true;
    }

    // распаковываем программу из assets/nodeproject.zip, если версия поменялась
    private static void unpack(Context ctx, File proj) throws Exception {
        String ver = readAsset(ctx, "nodeproject.version").trim();
        File stamp = new File(proj, ".version");
        if (stamp.exists() && ver.equals(readFile(stamp).trim())) return;
        deleteTree(proj); proj.mkdirs();
        try (ZipInputStream zin = new ZipInputStream(ctx.getAssets().open("nodeproject.zip"))) {
            ZipEntry e; byte[] buf = new byte[65536];
            while ((e = zin.getNextEntry()) != null) {
                File f = new File(proj, e.getName());
                if (!f.getCanonicalPath().startsWith(proj.getCanonicalPath())) continue;
                if (e.isDirectory()) { f.mkdirs(); continue; }
                f.getParentFile().mkdirs();
                try (OutputStream o = new FileOutputStream(f)) { int n; while ((n = zin.read(buf)) > 0) o.write(buf, 0, n); }
            }
        }
        try (OutputStream o = new FileOutputStream(stamp)) { o.write(ver.getBytes(StandardCharsets.UTF_8)); }
    }
    private static void deleteTree(File f) { File[] l = f.listFiles(); if (l != null) for (File x : l) deleteTree(x); f.delete(); }
    static String readAsset(Context c, String n) { try (InputStream in = c.getAssets().open(n)) { return new String(readAll(in), StandardCharsets.UTF_8); } catch (Exception e) { return ""; } }
    static String readFile(File f) { try (InputStream in = new java.io.FileInputStream(f)) { return new String(readAll(in), StandardCharsets.UTF_8); } catch (Exception e) { return ""; } }
    static byte[] readAll(InputStream in) throws Exception { ByteArrayOutputStream bo = new ByteArrayOutputStream(); byte[] b = new byte[65536]; int n; while ((n = in.read(b)) > 0) bo.write(b, 0, n); return bo.toByteArray(); }

    // ---------- связь с node ----------
    static String post(String path, String body) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(HOME + path).openConnection();
            c.setConnectTimeout(3000); c.setReadTimeout(30000);
            c.setRequestMethod("POST"); c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream o = c.getOutputStream()) { o.write(body.getBytes(StandardCharsets.UTF_8)); }
            return new String(readAll(c.getInputStream()), StandardCharsets.UTF_8);
        } catch (Exception e) { return null; } finally { if (c != null) c.disconnect(); }
    }
    /** вызвать обработчик программы (как IPC на ПК) от имени страницы */
    static String ipc(String ch, Object... args) {
        try {
            JSONArray a = new JSONArray(); for (Object x : args) a.put(x == null ? JSONObject.NULL : x);
            return post("/ipc", new JSONObject().put("ch", ch).put("args", a).put("role", "main").toString());
        } catch (Exception e) { return null; }
    }
    static void tell(JSONObject m) { post("/java", m.toString()); }

    static boolean alive() {
        HttpURLConnection c = null;
        try { c = (HttpURLConnection) new URL(HOME + "/launcher.html").openConnection(); c.setConnectTimeout(800); c.setReadTimeout(1500); return c.getResponseCode() == 200; }
        catch (Exception e) { return false; } finally { if (c != null) c.disconnect(); }
    }

    /** события от программы: куда перейти, уведомления, «скопировать», выбор файла и т. п. */
    static void listen(final Events ev) {
        Thread t = new Thread(new Runnable() { public void run() {
            while (true) {
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL(HOME + "/java-events").openConnection();
                    c.setConnectTimeout(2000); c.setReadTimeout(40000);
                    JSONArray a = new JSONArray(new String(readAll(c.getInputStream()), StandardCharsets.UTF_8));
                    for (int i = 0; i < a.length(); i++) { try { ev.onEvent(a.getJSONObject(i)); } catch (Exception e) { Log.e("kentovka", "событие", e); } }
                } catch (Exception e) {
                    try { Thread.sleep(700); } catch (InterruptedException ignored) {}
                } finally { if (c != null) c.disconnect(); }
            }
        } }, "kentovka-events");
        t.setDaemon(true); t.start();
    }
}

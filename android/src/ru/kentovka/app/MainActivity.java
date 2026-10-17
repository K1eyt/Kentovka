package ru.kentovka.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.text.SimpleDateFormat;
import java.util.Base64;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Кентовка для Android: стартовый экран (assets/launcher.html) и страница сервера в WebView.
 * Голос, чат, стримы и файлы — та же страница, что в приложении на ПК; аккаунт — тот же ключ Ed25519.
 */
public class MainActivity extends Activity {
    static final String LAUNCHER = "file:///android_asset/launcher.html";
    static final int DEFAULT_PORT = 8443;
    private WebView web;
    private SharedPreferences prefs;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private Discovery discovery;
    AudioRoute audio;
    String callOn = null, voiceOn = null; // что сейчас держит звук: звонок в личке / голос на сервере
    private volatile LocalProxy proxy;
    private volatile boolean nodeMode = false;
    private static final int REQ_PICK = 7;
    private volatile String currentKey = null;   // адрес сервера, как он сохранён (ip:порт)
    private volatile String currentHost = null;  // куда реально подключены (может быть мост)
    private volatile boolean viaAlt = false;
    private final Map<String, String> certSeen = new HashMap<>();
    private PermissionRequest pendingPerm;
    private ValueCallback<Uri[]> fileCb;
    private static final int REQ_MIC = 1, REQ_FILE = 2, REQ_SAVE = 3, REQ_NOTIF = 4, REQ_SCREEN = 6;
    private int screenMax = 1280, screenFps = 10;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = getSharedPreferences("kentovka", MODE_PRIVATE);
        ensureAccount();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        getWindow().setStatusBarColor(0xFF0A0B14);
        getWindow().setNavigationBarColor(0xFF0A0B14);
        web = new WebView(this);
        web.setBackgroundColor(0xFF0A0B14);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setUserAgentString(s.getUserAgentString() + " KentovkaAndroid/1.8.0");
        web.addJavascriptInterface(new Bridge(), "KentovkaAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        audio = new AudioRoute(this);
        // программа Кентовки (как на ПК) — в node внутри приложения; если не запустилась — простой режим (только серверы)
        nodeMode = NodeHost.start(this);
        if (!nodeMode) { discovery = new Discovery(this); discovery.start(); }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIF);
        // отладочная сборка (проверки на GitHub): страницы можно смотреть через отладчик Chrome
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        handleIntent(getIntent());
        if (nodeMode) {
            migrateAccount();
            web.loadUrl("file:///android_asset/loading.html");
            NodeHost.listen(new NodeHost.Events() { public void onEvent(final JSONObject ev) { ui.post(new Runnable() { public void run() { onNodeEvent(ev); } }); } });
            new Thread(new Runnable() { public void run() {
                for (int i = 0; i < 100 && !NodeHost.alive(); i++) { try { Thread.sleep(150); } catch (InterruptedException ignored) {} }
                if (NodeHost.alive()) { sendIfaces(); ui.post(new Runnable() { public void run() { String u = web.getUrl(); if (u == null || u.startsWith("file:")) web.loadUrl(NodeHost.HOME + "/launcher.html"); } }); }
                else ui.post(new Runnable() { public void run() { nodeMode = false; discovery = new Discovery(MainActivity.this); discovery.start(); web.loadUrl(LAUNCHER); } });
            } }).start();
        } else web.loadUrl(LAUNCHER);
    }

    // аккаунт из 1.7.x (был в Java) — переносим в программу, чтобы серверы узнавали тебя как раньше
    private void migrateAccount() {
        try {
            java.io.File data = new java.io.File(getFilesDir(), "kentovka"); data.mkdirs();
            java.io.File acc = new java.io.File(data, "account.json"), fr = new java.io.File(data, "friends.json"), cfg = new java.io.File(data, "config.json");
            if (acc.exists() || !prefs.contains("seed") || prefs.getBoolean("fresh", false) && !config().has("servers")) return;
            byte[] sd = seed();
            JSONObject a = new JSONObject().put("id", accId()).put("pub", Base64.getEncoder().encodeToString(Ed25519.spki(Ed25519.publicKey(sd)))).put("priv", Ed25519.pem(sd)).put("created", prefs.getLong("created", System.currentTimeMillis()));
            try (java.io.OutputStream o = new java.io.FileOutputStream(acc)) { o.write(a.toString().getBytes(StandardCharsets.UTF_8)); }
            if (!fr.exists()) try (java.io.OutputStream o = new java.io.FileOutputStream(fr)) { o.write(new JSONObject().put("me", new JSONObject().put("id", accId())).put("friends", new JSONArray()).put("dms", new JSONObject()).put("groups", new JSONObject()).put("gm", new JSONObject()).toString().getBytes(StandardCharsets.UTF_8)); }
            if (!cfg.exists()) { JSONObject c = config(); JSONObject out = new JSONObject(); if (c.has("profile")) out.put("profile", c.get("profile")); if (c.has("servers")) out.put("servers", c.get("servers"));
                try (java.io.OutputStream o = new java.io.FileOutputStream(cfg)) { o.write(out.toString().getBytes(StandardCharsets.UTF_8)); } }
        } catch (Exception ignored) {}
    }
    private void sendIfaces() {
        try {
            JSONArray l = new JSONArray();
            for (java.net.NetworkInterface ni : java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (java.net.InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (!(ia.getAddress() instanceof java.net.Inet4Address)) continue;
                    int pl = ia.getNetworkPrefixLength(); long m = pl == 0 ? 0 : (0xffffffffL << (32 - pl)) & 0xffffffffL;
                    l.put(new JSONObject().put("name", ni.getName()).put("address", ia.getAddress().getHostAddress()).put("netmask", ((m >> 24) & 255) + "." + ((m >> 16) & 255) + "." + ((m >> 8) & 255) + "." + (m & 255)));
                }
            }
            NodeHost.tell(new JSONObject().put("t", "ifaces").put("list", l));
        } catch (Exception ignored) {}
    }
    private android.app.NotificationManager nm() { return (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE); }
    // события программы: куда перейти, уведомления, файлы, звонки
    private void onNodeEvent(JSONObject ev) {
        String t = ev.optString("t");
        switch (t) {
            case "nav": web.loadUrl(ev.optString("url")); break;
            case "copy": ((ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Кентовка", ev.optString("text"))); break;
            case "url": try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(ev.optString("url")))); } catch (Exception ignored) {} break;
            case "notify": {
                if (Build.VERSION.SDK_INT >= 26) nm().createNotificationChannel(new android.app.NotificationChannel("msgs", "Сообщения и звонки", android.app.NotificationManager.IMPORTANCE_HIGH));
                Intent it = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra("knotify", ev.optString("id"));
                android.app.PendingIntent pi = android.app.PendingIntent.getActivity(this, ev.optString("id").hashCode(), it, android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
                android.app.Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new android.app.Notification.Builder(this, "msgs") : new android.app.Notification.Builder(this);
                nm().notify(ev.optString("id").hashCode(), b.setSmallIcon(R.drawable.ic_voice).setContentTitle(ev.optString("title")).setContentText(ev.optString("body")).setAutoCancel(true).setContentIntent(pi).build());
                break;
            }
            case "pick": {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT); i.addCategory(Intent.CATEGORY_OPENABLE); i.setType("*/*");
                try { startActivityForResult(i, REQ_PICK); } catch (Exception e) { NodeHost.tell(jo("t", "picked")); }
                break;
            }
            case "saved": case "open": copyToDownloads(ev.optString("path"), ev.optString("name"), "open".equals(t)); break;
            case "mirror": mirrorSaves(ev.optString("dir"), ev.optJSONArray("files")); break;
            case "call": case "voice": {
                // звонок в личке и голос на сервере: служба (чтобы не обрывалось в фоне) и звук — пока идёт хоть что-то
                JSONObject st = ev.optJSONObject("st");
                boolean on = st != null && ("call".equals(t) || st.optBoolean("inVoice", true));
                if ("call".equals(t)) callOn = on ? st.optString("name", "звонок") : null; else voiceOn = on ? st.optString("ch", "голосовой канал") : null;
                String what = callOn != null ? callOn : voiceOn;
                if (what != null) { VoiceService.start(this, what); audio.start(); } else { VoiceService.stop(this); audio.stop(); }
                break;
            }
            case "relaunch": case "exit": {
                android.app.AlarmManager am = (android.app.AlarmManager) getSystemService(ALARM_SERVICE);
                android.app.PendingIntent pi = android.app.PendingIntent.getActivity(this, 1, new Intent(this, MainActivity.class), android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_CANCEL_CURRENT);
                if ("relaunch".equals(t)) am.set(android.app.AlarmManager.RTC, System.currentTimeMillis() + 600, pi);
                finishAffinity(); System.exit(0);
                break;
            }
        }
    }
    static JSONObject jo(Object... kv) { JSONObject o = new JSONObject(); try { for (int i = 0; i + 1 < kv.length; i += 2) o.put(String.valueOf(kv[i]), kv[i + 1]); } catch (Exception ignored) {} return o; }
    // файл из программы — в «Загрузки» телефона (ждём, пока он допишется)
    private void copyToDownloads(final String path, final String name0, final boolean open) {
        new Thread(new Runnable() { public void run() {
            try {
                java.io.File f = new java.io.File(path); long last = -1;
                for (int i = 0; i < 100; i++) { long n = f.exists() ? f.length() : -1; if (n >= 0 && n == last) break; last = n; Thread.sleep(200); }
                if (!f.exists()) return;
                String name = name0 == null || name0.isEmpty() ? f.getName() : name0;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Kentovka");
                    Uri u = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (u == null) return;
                    try (java.io.InputStream in = new java.io.FileInputStream(f); OutputStream o = getContentResolver().openOutputStream(u)) { byte[] b = new byte[65536]; int n; while ((n = in.read(b)) > 0) o.write(b, 0, n); }
                    final Uri fu = u;
                    ui.post(new Runnable() { public void run() {
                        android.widget.Toast.makeText(MainActivity.this, "Сохранено в «Загрузки/Kentovka»: " + name, android.widget.Toast.LENGTH_LONG).show();
                        if (open) { try { startActivity(new Intent(Intent.ACTION_VIEW).setData(fu).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)); } catch (Exception ignored) {} }
                    } });
                }
            } catch (Exception ignored) {}
        } }).start();
    }

    // автосохранения аккаунта → «Документы/Kentovka/Сохранения» (переживают удаление приложения)
    private void mirrorSaves(final String dir, final JSONArray files) {
        if (Build.VERSION.SDK_INT < 29 || files == null) return;
        new Thread(new Runnable() { public void run() {
            synchronized (MainActivity.class) {
                try {
                    final String rel = Environment.DIRECTORY_DOCUMENTS + "/Kentovka/Сохранения/";
                    Uri base = MediaStore.Files.getContentUri("external");
                    java.util.HashMap<String, long[]> have = new java.util.HashMap<String, long[]>();
                    try (android.database.Cursor c = getContentResolver().query(base, new String[] { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE },
                            MediaStore.MediaColumns.RELATIVE_PATH + "=?", new String[] { rel }, null)) {
                        if (c != null) while (c.moveToNext()) have.put(c.getString(1), new long[] { c.getLong(0), c.getLong(2) });
                    }
                    java.util.HashSet<String> want = new java.util.HashSet<String>();
                    for (int i = 0; i < files.length(); i++) {
                        JSONObject f = files.getJSONObject(i); String name = f.getString("name"); long size = f.optLong("size");
                        want.add(name);
                        long[] h = have.get(name);
                        if (h != null && h[1] == size) continue;
                        if (h != null) getContentResolver().delete(android.content.ContentUris.withAppendedId(base, h[0]), null, null);
                        ContentValues v = new ContentValues();
                        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                        v.put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream");
                        v.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
                        Uri u = getContentResolver().insert(base, v);
                        if (u == null) continue;
                        try (java.io.InputStream in = new java.io.FileInputStream(new java.io.File(dir, name)); OutputStream o = getContentResolver().openOutputStream(u)) {
                            byte[] b = new byte[65536]; int n; while ((n = in.read(b)) > 0) o.write(b, 0, n);
                        }
                    }
                    for (java.util.Map.Entry<String, long[]> e : have.entrySet())
                        if (!want.contains(e.getKey())) getContentResolver().delete(android.content.ContentUris.withAppendedId(base, e.getValue()[0]), null, null);
                } catch (Exception e) { android.util.Log.w("kentovka", "копия сохранений", e); }
            }
        } }).start();
    }

    // запуск с параметрами (для проверок): ник и адрес сервера, куда сразу зайти
    private void handleIntent(Intent it) {
        if (it == null) return;
        if (nodeMode) { // проверки: ник и сервер — через программу
            final String nm = it.getStringExtra("kname"), addr = it.getStringExtra("kconnect");
            new Thread(new Runnable() { public void run() {
                for (int i = 0; i < 100 && !NodeHost.alive(); i++) { try { Thread.sleep(150); } catch (InterruptedException ignored) {} }
                try {
                    if (nm != null && !nm.trim().isEmpty()) NodeHost.ipc("app:profile-set", new JSONObject().put("name", nm.trim()));
                    if (addr != null && addr.matches("[\\w.:-]{3,80}")) { Thread.sleep(1500); NodeHost.ipc("launcher:connect", new JSONObject().put("address", addr).put("host", false)); }
                } catch (Exception ignored) {}
            } }).start();
            return;
        }
        try {
            String nm = it.getStringExtra("kname");
            if (nm != null && !nm.trim().isEmpty()) { JSONObject c = config(); JSONObject p = c.optJSONObject("profile"); if (p == null) p = new JSONObject(); p.put("name", nm.trim()); c.put("profile", p); saveConfig(c); }
            final String addr = it.getStringExtra("kconnect");
            if (addr != null && addr.matches("[\\w.:-]{3,80}")) ui.postDelayed(new Runnable() { public void run() { connect(addr, ""); } }, 1500);
        } catch (Exception ignored) {}
    }
    @Override protected void onNewIntent(Intent it) {
        super.onNewIntent(it); setIntent(it); handleIntent(it);
        final String nid = it.getStringExtra("knotify");
        if (nodeMode && nid != null) new Thread(new Runnable() { public void run() { NodeHost.tell(jo("t", "notifyClick", "id", nid)); } }).start();
    }
    @Override protected void onResume() { super.onResume(); if (nodeMode) new Thread(new Runnable() { public void run() { NodeHost.tell(jo("t", "focus", "on", true)); sendIfaces(); } }).start(); }
    @Override protected void onPause() { super.onPause(); if (nodeMode) new Thread(new Runnable() { public void run() { NodeHost.tell(jo("t", "focus", "on", false)); } }).start(); }

    @Override
    protected void onDestroy() {
        if (discovery != null) discovery.stop();
        VoiceService.stop(this);
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        String u = web.getUrl();
        // «назад» как в Discord: закрывает то, что открыто (окно, чат, сервер), а с главной — сворачивает приложение (не закрывает)
        if (nodeMode && u != null && u.startsWith(NodeHost.HOME)) {
            web.evaluateJavascript("(function(){try{return !!(window.kentovkaBack&&window.kentovkaBack())}catch(e){return false}})()", new android.webkit.ValueCallback<String>() {
                public void onReceiveValue(String v) { if (!"true".equals(v)) moveTaskToBack(true); }
            });
            return;
        }
        if (u != null && !u.startsWith("file:")) { // на сервере: «назад» — выйти на стартовый экран
            new AlertDialog.Builder(this).setMessage("Выйти с сервера на стартовый экран?")
                .setPositiveButton("Выйти", new android.content.DialogInterface.OnClickListener() { public void onClick(android.content.DialogInterface d, int w) { goLauncher(); } }).setNegativeButton("Остаться", null).show();
        } else super.onBackPressed();
    }

    void goLauncher() {
        if (nodeMode) { VoiceService.stop(this); if (audio != null) audio.stop(); new Thread(new Runnable() { public void run() { NodeHost.ipc("app:back"); } }).start(); return; }
        VoiceService.stop(this);
        if (audio != null) audio.stop();
        currentKey = null; currentHost = null; viaAlt = false;
        if (proxy != null) { proxy.stop(); proxy = null; }
        web.loadUrl(LAUNCHER);
    }

    // ---------- настройки и аккаунт ----------
    JSONObject config() {
        try { return new JSONObject(prefs.getString("config", "{}")); } catch (Exception e) { return new JSONObject(); }
    }
    void saveConfig(JSONObject c) { prefs.edit().putString("config", c.toString()).apply(); }

    private void ensureAccount() {
        if (prefs.contains("seed")) return;
        byte[] seed = new byte[32], id = new byte[16];
        SecureRandom r = new SecureRandom(); r.nextBytes(seed); r.nextBytes(id);
        prefs.edit().putString("seed", hex(seed)).putString("id", hex(id)).putLong("created", System.currentTimeMillis()).putBoolean("fresh", true).apply();
    }
    String accId() { return prefs.getString("id", ""); }
    byte[] seed() { return unhex(prefs.getString("seed", "")); }

    static String hex(byte[] b) { StringBuilder sb = new StringBuilder(); for (byte x : b) sb.append(String.format("%02x", x)); return sb.toString(); }
    static byte[] unhex(String s) { byte[] o = new byte[s.length() / 2]; for (int i = 0; i < o.length; i++) o[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16); return o; }

    static String friendCode(String id) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return "KNT-" + hex(md.digest(("kentovka-code:" + id).getBytes(StandardCharsets.UTF_8))).substring(0, 6).toUpperCase(Locale.ROOT);
        } catch (Exception e) { return ""; }
    }

    // ---------- сеть: доверяем только самоподписанному сертификату Кентовки ----------
    static boolean isOurs(X509Certificate c) {
        return c != null && c.getSubjectX500Principal().getName().contains("CN=kentovka");
    }
    static SSLContext trustKentovka() throws Exception {
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[] { new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] ch, String a) {}
            public void checkServerTrusted(X509Certificate[] ch, String a) throws java.security.cert.CertificateException {
                if (ch == null || ch.length == 0 || !isOurs(ch[0])) throw new java.security.cert.CertificateException("не Кентовка");
            }
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        } }, new SecureRandom());
        return ctx;
    }
    static boolean reachable(String url) {
        try {
            HttpsURLConnection c = (HttpsURLConnection) new URL(url + "/__temp").openConnection();
            c.setSSLSocketFactory(trustKentovka().getSocketFactory());
            c.setHostnameVerifier(new HostnameVerifier() { public boolean verify(String h, javax.net.ssl.SSLSession sess) { return true; } });
            c.setConnectTimeout(2500); c.setReadTimeout(2500);
            c.getResponseCode(); c.disconnect();
            return true;
        } catch (Exception e) { return false; }
    }

    static String normAddr(String a) {
        a = a.trim().replaceAll("^https?://", "").replaceAll("/.*$", "");
        if (a.isEmpty()) return "";
        if (!a.matches(".*:\\d+$")) a += ":" + DEFAULT_PORT;
        return a;
    }

    JSONObject serverEntry(JSONObject c, String key) throws Exception {
        JSONArray list = c.optJSONArray("servers");
        if (list == null) { list = new JSONArray(); c.put("servers", list); }
        for (int i = 0; i < list.length(); i++) if (key.equals(list.getJSONObject(i).optString("address"))) return list.getJSONObject(i);
        return null;
    }

    // порядок запасных адресов: общая сеть → свой мост → мост сервера → остальные
    java.util.List<String> altOrder(JSONObject sv) {
        java.util.List<String> out = new java.util.ArrayList<>();
        JSONArray alts = sv == null ? null : sv.optJSONArray("alts");
        if (alts == null) return out;
        java.util.List<JSONObject> l = new java.util.ArrayList<>();
        for (int i = 0; i < alts.length(); i++) l.add(alts.optJSONObject(i));
        java.util.Collections.sort(l, new java.util.Comparator<JSONObject>() { public int compare(JSONObject a, JSONObject b) { return rank(a) - rank(b); } });
        for (JSONObject a : l) if (a != null) out.add(a.optString("addr"));
        return out;
    }
    private int rank(JSONObject a) { if (a == null) return 9; if (!"bridge".equals(a.optString("net"))) return 0; return a.optBoolean("own") ? 2 : 3; }

    void connect(final String address, final String name) {
        final String key = normAddr(address);
        if (key.isEmpty()) { js("window.onConnectError && onConnectError('Впиши адрес сервера')"); return; }
        new Thread(new Runnable() { public void run() {
            String target = null;
            JSONObject c = config(); JSONObject sv = null;
            try { sv = serverEntry(c, key); } catch (Exception ignored) {}
            if (reachable("https://" + key)) target = key;
            else for (String alt : altOrder(sv)) if (reachable("https://" + alt)) { target = alt; break; }
            if (target == null) {
                js("window.onConnectError && onConnectError(" + JSONObject.quote("Не достучался до " + key + ". Хост запустил Кентовку? Ты в той же локальной сети или у сервера есть мост?") + ")");
                return;
            }
            try {
                c = config(); sv = serverEntry(c, key);
                if (sv == null) { sv = new JSONObject(); sv.put("address", key); c.getJSONArray("servers").put(sv); }
                if (name != null && !name.isEmpty()) sv.put("name", name);
                sv.put("last", System.currentTimeMillis());
                saveConfig(c);
            } catch (Exception ignored) {}
            final String t = target;
            // страница идёт через мостик на телефоне: http://127.0.0.1:порт → TLS к серверу
            final LocalProxy lp;
            try {
                int i = t.lastIndexOf(':');
                lp = new LocalProxy(t.substring(0, i), Integer.parseInt(t.substring(i + 1)), new LocalProxy.Pins() {
                    public boolean ok(String h, String fp) { Set<String> p = bridgePins(h); return p == null || p.isEmpty() || p.contains(fp); }
                });
                lp.start();
            } catch (Exception e) {
                js("window.onConnectError && onConnectError(" + JSONObject.quote("Не получилось открыть сервер: " + e.getMessage()) + ")");
                return;
            }
            ui.post(new Runnable() { public void run() {
                if (proxy != null) proxy.stop();
                proxy = lp; currentKey = key; currentHost = t; viaAlt = !t.equals(key);
                web.loadUrl("http://127.0.0.1:" + lp.localPort + "/");
            } });
        } }).start();
    }

    void js(final String code) { ui.post(new Runnable() { public void run() { web.evaluateJavascript(code, null); } }); }

    // ---------- сохранение аккаунта: тот же формат .knt, что на ПК ----------
    JSONObject accountJson() throws Exception {
        JSONObject a = new JSONObject();
        a.put("id", accId());
        a.put("pub", Base64.getEncoder().encodeToString(Ed25519.spki(Ed25519.publicKey(seed()))));
        a.put("priv", Ed25519.pem(seed()));
        a.put("created", prefs.getLong("created", System.currentTimeMillis()));
        return a;
    }
    JSONObject bundle() throws Exception {
        JSONObject c = config();
        JSONObject cfg = new JSONObject();
        cfg.put("profile", c.optJSONObject("profile") == null ? JSONObject.NULL : c.optJSONObject("profile"));
        cfg.put("servers", c.optJSONArray("servers") == null ? new JSONArray() : c.optJSONArray("servers"));
        JSONObject f = prefs.contains("friendsDb") ? new JSONObject(prefs.getString("friendsDb", "{}")) : new JSONObject().put("me", new JSONObject().put("id", accId())).put("friends", new JSONArray()).put("dms", new JSONObject()).put("groups", new JSONObject()).put("gm", new JSONObject());
        return new JSONObject().put("v", 1).put("magic", "kentovka-account").put("at", System.currentTimeMillis()).put("account", accountJson()).put("config", cfg).put("friends", f);
    }
    static JSONObject decryptSave(JSONObject f, String password) throws Exception {
        if (!"kentovka-account".equals(f.optString("magic"))) throw new Exception("Это не сохранение Кентовки");
        if (!f.optBoolean("enc")) return new JSONObject(new String(Base64.getDecoder().decode(f.getString("data")), StandardCharsets.UTF_8));
        if (password == null || password.isEmpty()) throw new Exception("Нужен пароль от сохранения");
        byte[] key = Scrypt.derive(password.getBytes(StandardCharsets.UTF_8), Base64.getDecoder().decode(f.getString("salt")), 1 << 15, 8, 1, 32);
        byte[] data = Base64.getDecoder().decode(f.getString("data")), tag = Base64.getDecoder().decode(f.getString("tag"));
        byte[] ct = new byte[data.length + tag.length];
        System.arraycopy(data, 0, ct, 0, data.length); System.arraycopy(tag, 0, ct, data.length, tag.length);
        Cipher cip = Cipher.getInstance("AES/GCM/NoPadding");
        cip.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, Base64.getDecoder().decode(f.getString("iv"))));
        try { return new JSONObject(new String(cip.doFinal(ct), StandardCharsets.UTF_8)); }
        catch (javax.crypto.AEADBadTagException e) { throw new Exception("Неверный пароль"); }
    }
    static JSONObject encryptSave(JSONObject obj, String password) throws Exception {
        byte[] plain = obj.toString().getBytes(StandardCharsets.UTF_8);
        JSONObject prof = obj.getJSONObject("config").optJSONObject("profile");
        JSONObject out = new JSONObject().put("magic", "kentovka-account").put("v", 1).put("name", prof == null ? "" : prof.optString("name")).put("at", obj.getLong("at"));
        if (password == null || password.isEmpty()) return out.put("enc", false).put("data", Base64.getEncoder().encodeToString(plain));
        byte[] salt = new byte[16], iv = new byte[12]; SecureRandom r = new SecureRandom(); r.nextBytes(salt); r.nextBytes(iv);
        byte[] key = Scrypt.derive(password.getBytes(StandardCharsets.UTF_8), salt, 1 << 15, 8, 1, 32);
        Cipher cip = Cipher.getInstance("AES/GCM/NoPadding");
        cip.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        byte[] ct = cip.doFinal(plain);
        byte[] data = java.util.Arrays.copyOf(ct, ct.length - 16), tag = java.util.Arrays.copyOfRange(ct, ct.length - 16, ct.length);
        return out.put("enc", true).put("salt", Base64.getEncoder().encodeToString(salt)).put("iv", Base64.getEncoder().encodeToString(iv))
            .put("tag", Base64.getEncoder().encodeToString(tag)).put("data", Base64.getEncoder().encodeToString(data));
    }
    void applyBundle(JSONObject b) throws Exception {
        JSONObject a = b.getJSONObject("account");
        String id = a.getString("id");
        if (!id.matches("[0-9a-f]{32}")) throw new Exception("Испорченное сохранение");
        byte[] seed = Ed25519.seedFromPem(a.getString("priv"));
        prefs.edit().putString("id", id).putString("seed", hex(seed)).putLong("created", a.optLong("created", System.currentTimeMillis()))
            .putString("friendsDb", b.optJSONObject("friends") == null ? "{}" : b.getJSONObject("friends").toString()).putBoolean("fresh", false).apply();
        JSONObject c = config();
        JSONObject cfg = b.optJSONObject("config");
        if (cfg != null) {
            if (cfg.optJSONObject("profile") != null) c.put("profile", cfg.getJSONObject("profile"));
            JSONArray mine = c.optJSONArray("servers"); if (mine == null) { mine = new JSONArray(); c.put("servers", mine); }
            JSONArray theirs = cfg.optJSONArray("servers");
            if (theirs != null) for (int i = 0; i < theirs.length(); i++) {
                JSONObject x = theirs.optJSONObject(i); if (x == null || x.optBoolean("host")) continue; // свои серверы ПК с телефона не держим
                if (serverEntry(c, x.optString("address")) == null) mine.put(x);
            }
        }
        saveConfig(c);
    }
    // в «Документы/Kentovka» — переживает удаление приложения (Android 10+: через MediaStore)
    String saveToDocuments(String password) throws Exception {
        JSONObject obj = bundle();
        byte[] bytes = encryptSave(obj, password).toString().getBytes(StandardCharsets.UTF_8);
        JSONObject prof = config().optJSONObject("profile");
        String nick = prof == null ? "аккаунт" : prof.optString("name", "аккаунт").replaceAll("[\\\\/:*?\"<>|]", "");
        String name = "Кентовка-" + (nick.isEmpty() ? "аккаунт" : nick) + "-" + new SimpleDateFormat("yyyy-MM-dd_HH-mm", Locale.ROOT).format(new Date()) + ".knt";
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream");
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOCUMENTS + "/Kentovka");
            Uri u = getContentResolver().insert(MediaStore.Files.getContentUri("external"), v);
            if (u == null) throw new Exception("Не получилось создать файл в «Документах»");
            try (OutputStream o = getContentResolver().openOutputStream(u)) { o.write(bytes); }
        } else {
            java.io.File dir = new java.io.File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), "Kentovka");
            dir.mkdirs();
            try (OutputStream o = new java.io.FileOutputStream(new java.io.File(dir, name))) { o.write(bytes); }
        }
        prefs.edit().putLong("lastSave", System.currentTimeMillis()).apply();
        return "Документы/Kentovka/" + name;
    }

    // ---------- мостик для страниц ----------
    class Bridge {
        @JavascriptInterface public String config() { return MainActivity.this.config().toString(); }
        @JavascriptInterface public void setConfig(String json) { try { saveConfig(new JSONObject(json)); } catch (Exception ignored) {} }
        @JavascriptInterface public void connect(final String address, final String name) { MainActivity.this.connect(address, name); }
        @JavascriptInterface public void back() { if (nodeMode) { VoiceService.stop(MainActivity.this); audio.stop(); NodeHost.ipc("app:back"); return; } ui.post(new Runnable() { public void run() { goLauncher(); } }); }
        @JavascriptInterface public String profile() {
            if (nodeMode) { String r = NodeHost.ipc("app:profile-get"); return r == null ? "null" : r; }
            JSONObject p = MainActivity.this.config().optJSONObject("profile"); return p == null ? "null" : p.toString();
        }
        @JavascriptInterface public boolean setProfile(String json) {
            if (nodeMode) { try { NodeHost.ipc("app:profile-set", new JSONObject(json)); return true; } catch (Exception e) { return false; } }
            try { JSONObject c = MainActivity.this.config(); c.put("profile", new JSONObject(json)); c.put("profileAt", System.currentTimeMillis()); saveConfig(c); return true; } catch (Exception e) { return false; }
        }
        // подпись для входа на сервер — только для того сервера, к которому мы сейчас подключены
        @JavascriptInterface public String sign(String nonce, String host) {
            if (nodeMode) { String r = NodeHost.ipc("account:sign", nonce, host); return r == null ? "null" : r; }
            try {
                // страница видит адрес мостика 127.0.0.1:порт — подписываем настоящий адрес сервера
                LocalProxy lp = proxy;
                if (lp != null && host.equals("127.0.0.1:" + lp.localPort)) host = currentHost;
                if (!nonce.matches("[0-9a-f]{16,64}") || currentHost == null || !currentHost.equals(host)) return "null";
                byte[] seed = seed();
                String text = "kentovka:" + nonce + ":" + accId() + ":" + host;
                JSONObject o = new JSONObject();
                o.put("id", accId());
                o.put("pub", Base64.getEncoder().encodeToString(Ed25519.spki(Ed25519.publicKey(seed))));
                o.put("sig", Base64.getEncoder().encodeToString(Ed25519.sign(seed, text.getBytes(StandardCharsets.UTF_8))));
                o.put("host", host);
                return o.toString();
            } catch (Exception e) { return "null"; }
        }
        @JavascriptInterface public void serverAlts(String json) {
            if (nodeMode) { try { NodeHost.ipc("server:alts", new JSONArray(json)); } catch (Exception ignored) {} return; }
            try {
                if (currentKey == null) return;
                JSONArray in = new JSONArray(json), out = new JSONArray();
                for (int i = 0; i < in.length() && out.length() < 12; i++) {
                    JSONObject a = in.optJSONObject(i); if (a == null || !a.optString("addr").matches("[\\w.-]{1,200}:\\d{2,5}")) continue;
                    out.put(new JSONObject().put("addr", a.optString("addr")).put("net", a.optString("net")).put("own", a.optBoolean("own")));
                }
                JSONObject c = MainActivity.this.config(); JSONObject sv = serverEntry(c, currentKey); if (sv == null) return;
                sv.put("alts", out);
                if (!viaAlt && currentHost != null) {
                    String fp = proxy != null && proxy.lastFp != null ? proxy.lastFp : certSeen.get(currentHost.replaceAll(":\\d+$", ""));
                    if (fp != null) { JSONArray fps = sv.optJSONArray("fps"); if (fps == null) { fps = new JSONArray(); sv.put("fps", fps); } boolean has = false; for (int i = 0; i < fps.length(); i++) if (fp.equals(fps.optString(i))) has = true; if (!has) fps.put(fp); }
                }
                saveConfig(c);
            } catch (Exception ignored) {}
        }
        @JavascriptInterface public void voiceState(String json) {
            if (nodeMode) { try { NodeHost.ipc("voice:state", "null".equals(json) ? null : new JSONObject(json)); } catch (Exception ignored) {} }
            try {
                JSONObject st = "null".equals(json) ? null : new JSONObject(json);
                if (st != null && st.optBoolean("inVoice")) {
                    VoiceService.start(MainActivity.this, st.optString("ch")); audio.start();
                    if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission("android.permission.BLUETOOTH_CONNECT") != PackageManager.PERMISSION_GRANTED)
                        ui.post(new Runnable() { public void run() { requestPermissions(new String[] { "android.permission.BLUETOOTH_CONNECT" }, 5); } });
                } else { VoiceService.stop(MainActivity.this); audio.stop(); }
            } catch (Exception ignored) {}
        }
        @JavascriptInterface public void copy(final String t) {
            ui.post(new Runnable() { public void run() { ((ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Кентовка", t)); } });
        }
        // демка: системное окно «Начать запись экрана?», потом кадры идут странице
        @JavascriptInterface public void startScreen(int maxSide, int fps) {
            screenMax = Math.max(480, Math.min(1920, maxSide)); screenFps = fps;
            ui.post(new Runnable() { public void run() {
                try {
                    android.media.projection.MediaProjectionManager mpm = (android.media.projection.MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
                    startActivityForResult(mpm.createScreenCaptureIntent(), REQ_SCREEN);
                } catch (Exception e) { js("window.__kScreen && __kScreen(false)"); }
            } });
        }
        @JavascriptInterface public void stopScreen() { ScreenService.stop(MainActivity.this); }
        @JavascriptInterface public String audioDevices() { return audio.json(); }
        @JavascriptInterface public void setAudioDevice(String kind, String id) { if ("in".equals(kind)) audio.setIn(id); else audio.setOut(id); }
        @JavascriptInterface public String lan() { return discovery == null ? "[]" : discovery.servers().toString(); }
        @JavascriptInterface public String account() {
            try {
                return new JSONObject().put("id", accId()).put("code", friendCode(accId())).put("fresh", prefs.getBoolean("fresh", false))
                    .put("lastSave", prefs.getLong("lastSave", 0)).put("cellular", isCellular()).toString();
            } catch (Exception e) { return "{}"; }
        }
        @JavascriptInterface public void notFresh() { prefs.edit().putBoolean("fresh", false).apply(); }
        @JavascriptInterface public void pickSave() { ui.post(new Runnable() { public void run() {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT); i.addCategory(Intent.CATEGORY_OPENABLE); i.setType("*/*");
            startActivityForResult(i, REQ_SAVE);
        } }); }
        // восстановить из выбранного файла (текст файла передаёт страница обратно с паролем)
        @JavascriptInterface public String restore(String fileText, String password) {
            try { applyBundle(decryptSave(new JSONObject(fileText), password)); return "{\"ok\":true}"; }
            catch (Exception e) { return errJson(e); }
        }
        @JavascriptInterface public void saveAccount(final String password) {
            new Thread(new Runnable() { public void run() {
                try { String where = saveToDocuments(password); js("window.onSaved && onSaved(" + JSONObject.quote(where) + ", null)"); }
                catch (Exception e) { js("window.onSaved && onSaved(null, " + JSONObject.quote(String.valueOf(e.getMessage())) + ")"); }
            } }).start();
        }
    }
    static String errJson(Exception e) { try { return new JSONObject().put("error", String.valueOf(e.getMessage())).toString(); } catch (Exception x) { return "{\"error\":\"ошибка\"}"; } }

    boolean isCellular() {
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            android.net.NetworkCapabilities nc = cm.getNetworkCapabilities(cm.getActiveNetwork());
            return nc != null && nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR);
        } catch (Exception e) { return false; }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_PICK) {
            final Uri u = res == RESULT_OK && data != null ? data.getData() : null;
            new Thread(new Runnable() { public void run() {
                if (u == null) { NodeHost.tell(jo("t", "picked")); return; }
                try {
                    String name = "file";
                    try (android.database.Cursor c = getContentResolver().query(u, null, null, null, null)) { if (c != null && c.moveToFirst()) { int i = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME); if (i >= 0) name = c.getString(i); } }
                    java.io.File dir = new java.io.File(getCacheDir(), "picked"); dir.mkdirs();
                    java.io.File f = new java.io.File(dir, name.replaceAll("[/\\\\]", "_"));
                    try (InputStream in = getContentResolver().openInputStream(u); OutputStream o = new java.io.FileOutputStream(f)) { byte[] b = new byte[65536]; int n; while ((n = in.read(b)) > 0) o.write(b, 0, n); }
                    NodeHost.tell(jo("t", "picked", "path", f.getAbsolutePath()));
                } catch (Exception e) { NodeHost.tell(jo("t", "picked")); }
            } }).start();
            return;
        }
        if (req == REQ_SCREEN) {
            if (res != RESULT_OK || data == null) { js("window.__kScreen && __kScreen(false)"); return; }
            ScreenService.onEnd = new Runnable() { public void run() { js("window.__kScreenEnd && __kScreenEnd()"); } };
            ScreenService.start(this, res, data, screenMax, screenFps);
            // ждём первый кадр — тогда известен размер
            final long t0 = System.currentTimeMillis();
            ui.postDelayed(new Runnable() { public void run() {
                if (ScreenService.latest != null) { js("window.__kScreen && __kScreen(true," + ScreenService.fw + "," + ScreenService.fh + ")"); return; }
                if (System.currentTimeMillis() - t0 > 6000) { ScreenService.stop(MainActivity.this); js("window.__kScreen && __kScreen(false)"); return; }
                ui.postDelayed(this, 150);
            } }, 300);
            return;
        }
        if (req == REQ_SAVE) {
            if (res != RESULT_OK || data == null || data.getData() == null) return;
            try (InputStream in = getContentResolver().openInputStream(data.getData())) {
                ByteArrayOutputStream bo = new ByteArrayOutputStream(); byte[] buf = new byte[65536]; int n;
                while ((n = in.read(buf)) > 0) { bo.write(buf, 0, n); if (bo.size() > 20 * 1024 * 1024) throw new Exception("Файл слишком большой"); }
                String text = new String(bo.toByteArray(), StandardCharsets.UTF_8);
                js("window.onSavePicked && onSavePicked(" + JSONObject.quote(text) + ")");
            } catch (Exception e) { js("window.onSavePicked && onSavePicked(null, " + JSONObject.quote(String.valueOf(e.getMessage())) + ")"); }
            return;
        }
        if (req == REQ_FILE && fileCb != null) {
            fileCb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            fileCb = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        if (req == REQ_MIC && pendingPerm != null) {
            if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) pendingPerm.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            else pendingPerm.deny();
            pendingPerm = null;
        }
    }

    class Chrome extends WebChromeClient {
        @Override public void onPermissionRequest(final PermissionRequest r) {
            ui.post(new Runnable() { public void run() {
                boolean wantsMic = false;
                for (String x : r.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(x)) wantsMic = true;
                if (!wantsMic) { r.deny(); return; }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) r.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                else { pendingPerm = r; requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQ_MIC); }
            } });
        }
        @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
            if (fileCb != null) fileCb.onReceiveValue(null);
            fileCb = cb;
            try { startActivityForResult(p.createIntent(), REQ_FILE); } catch (Exception e) { fileCb = null; return false; }
            return true;
        }
    }

    class Client extends WebViewClient {
        // последний кадр демки — для страницы (тот же адрес сервера, поэтому без ограничений браузера)
        @Override public android.webkit.WebResourceResponse shouldInterceptRequest(WebView v, android.webkit.WebResourceRequest req) {
            Uri u = req.getUrl();
            if (u != null && "/__kandroid_frame".equals(u.getPath())) {
                byte[] f = ScreenService.latest;
                Map<String, String> h = new HashMap<>(); h.put("Cache-Control", "no-store");
                if (f == null) return new android.webkit.WebResourceResponse("image/jpeg", null, 204, "No frame", h, new java.io.ByteArrayInputStream(new byte[0]));
                return new android.webkit.WebResourceResponse("image/jpeg", null, 200, "OK", h, new java.io.ByteArrayInputStream(f));
            }
            return null;
        }
        @Override public void onReceivedSslError(WebView v, SslErrorHandler h, SslError err) {
            try {
                SslCertificate sc = err.getCertificate();
                boolean ours = sc != null && "kentovka".equals(sc.getIssuedTo().getCName());
                if (!ours) { h.cancel(); return; }
                String host = Uri.parse(err.getUrl()).getHost();
                if (Build.VERSION.SDK_INT >= 29 && sc.getX509Certificate() != null) {
                    byte[] der = sc.getX509Certificate().getEncoded();
                    String fp = "sha256/" + Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(der));
                    certSeen.put(host, fp);
                    // через мост пускаем только к тому же серверу, что видели по общей сети
                    Set<String> pins = bridgePins(host);
                    if (pins != null && !pins.isEmpty() && !pins.contains(fp)) { h.cancel(); return; }
                }
                h.proceed();
            } catch (Exception e) { h.cancel(); }
        }
        @Override public void onReceivedError(WebView v, android.webkit.WebResourceRequest req, android.webkit.WebResourceError e) {
            if (req.isForMainFrame() && !String.valueOf(req.getUrl()).startsWith("file:")) {
                ui.post(new Runnable() { public void run() { goLauncher(); ui.postDelayed(new Runnable() { public void run() { js("window.onConnectError && onConnectError('Связь с сервером пропала')"); } }, 600); } });
            }
        }
    }

    Set<String> bridgePins(String host) {
        try {
            JSONArray list = config().optJSONArray("servers"); if (list == null) return null;
            Set<String> out = new HashSet<>(); boolean any = false;
            for (int i = 0; i < list.length(); i++) {
                JSONObject sv = list.getJSONObject(i); JSONArray alts = sv.optJSONArray("alts"); if (alts == null) continue;
                for (int k = 0; k < alts.length(); k++) {
                    JSONObject a = alts.optJSONObject(k);
                    if (a != null && "bridge".equals(a.optString("net")) && a.optString("addr").startsWith(host + ":")) {
                        any = true; JSONArray fps = sv.optJSONArray("fps"); if (fps != null) for (int j = 0; j < fps.length(); j++) out.add(fps.optString(j));
                    }
                }
            }
            return any ? out : null;
        } catch (Exception e) { return null; }
    }
}

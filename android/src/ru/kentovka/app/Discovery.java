package ru.kentovka.app;

import android.content.Context;
import android.net.wifi.WifiManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** «Серверы рядом»: слушаем, как Кентовки на ПК кричат в общую сеть (UDP 8447), и сами спрашиваем «кто тут?». */
public class Discovery {
    static final int PORT = 8447;
    private final Context ctx;
    private volatile boolean running;
    private DatagramSocket sock;
    private WifiManager.MulticastLock lock;
    private final Map<String, JSONObject> peers = new ConcurrentHashMap<>();

    Discovery(Context c) { ctx = c.getApplicationContext(); }

    void start() {
        running = true;
        try {
            WifiManager wm = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
            lock = wm.createMulticastLock("kentovka-lan"); lock.setReferenceCounted(false); lock.acquire();
        } catch (Exception ignored) {}
        new Thread(new Runnable() { public void run() {
            try {
                sock = new DatagramSocket(null);
                sock.setReuseAddress(true);
                sock.setBroadcast(true);
                sock.bind(new InetSocketAddress(PORT));
                ask();
                byte[] buf = new byte[2048];
                while (running) {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    sock.receive(p);
                    try {
                        JSONObject m = new JSONObject(new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
                        if (!"kentovka".equals(m.optString("k")) || m.has("q")) continue;
                        String id = m.optString("id"); if (!id.matches("[0-9a-f]{32}")) continue;
                        m.put("ip", p.getAddress().getHostAddress()); m.put("seen", System.currentTimeMillis());
                        peers.put(id, m);
                    } catch (Exception ignored) {}
                }
            } catch (Exception ignored) {}
        } }, "kentovka-lan").start();
        new Thread(new Runnable() { public void run() { while (running) { try { Thread.sleep(5000); ask(); } catch (Exception ignored) {} } } }, "kentovka-lan-ask").start();
    }

    void ask() {
        try {
            if (sock == null) return;
            byte[] q = "{\"k\":\"kentovka\",\"q\":1}".getBytes(StandardCharsets.UTF_8);
            sock.send(new DatagramPacket(q, q.length, InetAddress.getByName("255.255.255.255"), PORT));
        } catch (Exception ignored) {}
    }

    JSONArray servers() {
        JSONArray out = new JSONArray();
        long now = System.currentTimeMillis();
        for (Iterator<Map.Entry<String, JSONObject>> it = peers.entrySet().iterator(); it.hasNext(); ) {
            JSONObject p = it.next().getValue();
            if (now - p.optLong("seen") > 15000) { it.remove(); continue; }
            JSONArray sv = p.optJSONArray("servers"); if (sv == null) continue;
            for (int i = 0; i < sv.length(); i++) {
                JSONObject s = sv.optJSONObject(i); if (s == null) continue;
                try {
                    out.put(new JSONObject().put("name", s.optString("name", "Сервер")).put("owner", p.optString("name")).put("access", s.optString("access", "open"))
                        .put("address", p.optString("ip") + ":" + s.optInt("port", 8443)));
                } catch (Exception ignored) {}
            }
        }
        return out;
    }

    void stop() {
        running = false;
        try { if (sock != null) sock.close(); } catch (Exception ignored) {}
        try { if (lock != null) lock.release(); } catch (Exception ignored) {}
    }
}

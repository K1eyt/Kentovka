package ru.kentovka.app;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.util.Base64;

import javax.net.ssl.SSLSocket;

/**
 * Сервер Кентовки — с самоподписанным сертификатом, а WebView такие не пускает для WebSocket.
 * Поэтому страница открывается через этот мостик на телефоне: http://127.0.0.1:порт → TLS к серверу.
 * Шифрование до сервера сохраняется (TLS делает приложение), сертификат проверяем сами: только «kentovka»
 * и, если сервер уже знаком по локальной сети, — тот же самый (мост на VPS подменить его не может).
 */
public class LocalProxy {
    interface Pins { boolean ok(String host, String fp); }
    private ServerSocket ss;
    final String host; final int port; int localPort;
    volatile String lastFp = null;
    private volatile boolean on = true;
    private final Pins pins;

    LocalProxy(String host, int port, Pins pins) { this.host = host; this.port = port; this.pins = pins; }

    /** порт постоянный для сервера — чтобы настройки страницы (они привязаны к адресу) не терялись */
    int start() throws Exception {
        int base = 20000 + Math.abs((host + ":" + port).hashCode() % 20000);
        for (int i = 0; i < 20 && ss == null; i++) {
            try { ss = new ServerSocket(base + i, 50, InetAddress.getByName("127.0.0.1")); } catch (Exception ignored) {}
        }
        if (ss == null) ss = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        localPort = ss.getLocalPort();
        Thread t = new Thread(new Runnable() { public void run() {
            while (on) {
                try { final Socket c = ss.accept(); new Thread(new Runnable() { public void run() { serve(c); } }, "kproxy-conn").start(); }
                catch (Exception e) { if (!on) return; }
            }
        } }, "kproxy");
        t.setDaemon(true); t.start();
        return localPort;
    }

    private void serve(Socket c) {
        SSLSocket up = null;
        try {
            c.setTcpNoDelay(true);
            up = (SSLSocket) MainActivity.trustKentovka().getSocketFactory().createSocket(host, port);
            up.setTcpNoDelay(true);
            up.startHandshake();
            Certificate[] chain = up.getSession().getPeerCertificates();
            String fp = "sha256/" + Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded()));
            lastFp = fp;
            if (pins != null && !pins.ok(host, fp)) { up.close(); c.close(); return; }
            final SSLSocket u = up;
            Thread back = new Thread(new Runnable() { public void run() { pipe(u, c); } }, "kproxy-back");
            back.setDaemon(true); back.start();
            pipe(c, u);
        } catch (Exception e) {
            try { c.close(); } catch (Exception ignored) {}
            try { if (up != null) up.close(); } catch (Exception ignored) {}
        }
    }

    private static void pipe(Socket a, Socket b) {
        try {
            InputStream in = a.getInputStream(); OutputStream out = b.getOutputStream();
            byte[] buf = new byte[32 * 1024]; int n;
            while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); out.flush(); }
        } catch (Exception ignored) {
        } finally {
            try { a.close(); } catch (Exception ignored) {}
            try { b.close(); } catch (Exception ignored) {}
        }
    }

    void stop() { on = false; try { if (ss != null) ss.close(); } catch (Exception ignored) {} }
}

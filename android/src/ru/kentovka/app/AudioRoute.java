package ru.kentovka.app;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

/**
 * Куда идёт звук и откуда берётся микрофон: динамик, разговорный динамик, проводные, USB и Bluetooth-наушники.
 * На Android микрофон гарнитуры включается вместе с ней — поэтому выбор микрофона переключает и вывод на ту же гарнитуру.
 */
public class AudioRoute {
    private final AudioManager am;
    private String curOut = null, curIn = null;
    private boolean active = false;

    AudioRoute(Context c) { am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE); }

    private static String kindName(int t) {
        switch (t) {
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return "Динамик телефона";
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return "Разговорный динамик (к уху)";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET: return "Проводные наушники с микрофоном";
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES: return "Проводные наушники";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO: return "Bluetooth-гарнитура";
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP: return "Bluetooth-наушники";
            case AudioDeviceInfo.TYPE_USB_HEADSET: return "USB-гарнитура";
            case AudioDeviceInfo.TYPE_USB_DEVICE: return "USB-устройство";
            case 26: return "Bluetooth LE-гарнитура"; // TYPE_BLE_HEADSET
            case AudioDeviceInfo.TYPE_BUILTIN_MIC: return "Микрофон телефона";
            default: return null;
        }
    }
    private static boolean headsetType(int t) {
        return t == AudioDeviceInfo.TYPE_WIRED_HEADSET || t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || t == AudioDeviceInfo.TYPE_USB_HEADSET || t == 26;
    }

    /** в звонке: режим связи, по умолчанию — наушники, если подключены, иначе громкий динамик */
    synchronized void start() {
        if (active) return;
        active = true;
        try { am.setMode(AudioManager.MODE_IN_COMMUNICATION); } catch (Exception ignored) {}
        if (curOut == null) {
            String best = null;
            for (Dev d : outs()) { if (d.headset || d.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES) { best = d.id; break; } }
            if (best == null) for (Dev d : outs()) if (d.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) best = d.id;
            if (best != null) setOut(best);
        } else setOut(curOut);
    }
    synchronized void stop() {
        if (!active) return;
        active = false;
        try {
            if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice();
            else { am.setSpeakerphoneOn(false); am.stopBluetoothSco(); am.setBluetoothScoOn(false); }
            am.setMode(AudioManager.MODE_NORMAL);
        } catch (Exception ignored) {}
    }

    static class Dev { String id, name; int type; boolean headset; AudioDeviceInfo info; }

    private java.util.List<Dev> outs() {
        java.util.List<Dev> out = new java.util.ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) {
            List<AudioDeviceInfo> l = am.getAvailableCommunicationDevices();
            for (AudioDeviceInfo i : l) {
                String n = kindName(i.getType()); if (n == null) continue;
                Dev d = new Dev(); d.type = i.getType(); d.id = str(i.getId()); d.info = i; d.headset = headsetType(i.getType());
                CharSequence pn = i.getProductName();
                d.name = n + (d.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || d.type == 26 ? (pn != null && pn.length() > 0 ? " — " + pn : "") : "");
                out.add(d);
            }
        } else {
            // старые Android: громкий динамик / разговорный / гарнитура
            out.add(mk("speaker", "Динамик телефона", AudioDeviceInfo.TYPE_BUILTIN_SPEAKER));
            out.add(mk("earpiece", "Разговорный динамик (к уху)", AudioDeviceInfo.TYPE_BUILTIN_EARPIECE));
            for (AudioDeviceInfo i : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                int t = i.getType();
                if (t == AudioDeviceInfo.TYPE_WIRED_HEADSET || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES) { out.add(mk("wired", kindName(t), t)); break; }
            }
            for (AudioDeviceInfo i : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) if (i.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) { Dev d = mk("bt", "Bluetooth-гарнитура", AudioDeviceInfo.TYPE_BLUETOOTH_SCO); d.headset = true; out.add(d); break; }
        }
        return out;
    }
    private static String str(int i) { return java.lang.String.valueOf(i); }
    private static Dev mk(String id, String name, int type) { Dev d = new Dev(); d.id = id; d.name = name; d.type = type; d.headset = headsetType(type); return d; }

    synchronized void setOut(String id) {
        curOut = id;
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                for (Dev d : outs()) if (d.id.equals(id)) { am.setCommunicationDevice(d.info); curIn = d.headset ? id : "builtin"; return; }
            } else {
                am.stopBluetoothSco(); am.setBluetoothScoOn(false);
                if ("speaker".equals(id)) { am.setSpeakerphoneOn(true); curIn = "builtin"; }
                else if ("bt".equals(id)) { am.setSpeakerphoneOn(false); am.startBluetoothSco(); am.setBluetoothScoOn(true); curIn = "bt"; }
                else { am.setSpeakerphoneOn(false); curIn = "wired".equals(id) ? "wired" : "builtin"; }
            }
        } catch (Exception ignored) {}
    }

    synchronized void setIn(String id) {
        // микрофон гарнитуры — вместе с её выводом; «микрофон телефона» — вывод на громкий динамик (если сейчас на гарнитуре)
        if ("builtin".equals(id)) {
            for (Dev d : outs()) if (d.id.equals(curOut) && !d.headset) { curIn = "builtin"; return; }
            for (Dev d : outs()) if (d.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) { setOut(d.id); break; }
            curIn = "builtin";
            return;
        }
        setOut(id);
    }

    synchronized String json() {
        try {
            JSONArray o = new JSONArray(), in = new JSONArray();
            in.put(new JSONObject().put("id", "builtin").put("name", "Микрофон телефона"));
            for (Dev d : outs()) {
                o.put(new JSONObject().put("id", d.id).put("name", d.name));
                if (d.headset) in.put(new JSONObject().put("id", d.id).put("name", "Микрофон: " + d.name));
            }
            if (curOut == null) for (Dev d : outs()) if (d.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) curOut = d.id;
            return new JSONObject().put("outputs", o).put("inputs", in).put("curOut", curOut == null ? "" : curOut).put("curIn", curIn == null ? "builtin" : curIn)
                .put("note", "Микрофон гарнитуры включается вместе с ней: выбрал гарнитуру — звук тоже пойдёт в неё.").toString();
        } catch (Exception e) { return "null"; }
    }
}

package ru.kentovka.app;

import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputConnectionWrapper;
import android.view.inputmethod.InputContentInfo;
import android.webkit.WebView;

/**
 * WebView, в которое клавиатура может вставить картинку (скрин из её буфера, стикер, гифку).
 * Обычное поле в WebView картинки не принимает — клавиатура их зачёркивает. Здесь объявляем, что принимаем
 * изображения, и отдаём полученную картинку странице (в чат она уходит как вложение).
 */
public class KWebView extends WebView {
    interface OnImage { void image(InputContentInfo info); }
    OnImage onImage;

    public KWebView(Context c) { super(c); }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo out) {
        InputConnection ic = super.onCreateInputConnection(out);
        if (ic == null || Build.VERSION.SDK_INT < 25) return ic;
        out.contentMimeTypes = new String[] { "image/png", "image/jpeg", "image/gif", "image/webp", "image/*" };
        return new InputConnectionWrapper(ic, false) {
            @Override
            public boolean commitContent(InputContentInfo info, int flags, Bundle opts) {
                if (onImage == null) return super.commitContent(info, flags, opts);
                try { if ((flags & InputConnection.INPUT_CONTENT_GRANT_READ_URI_PERMISSION) != 0) info.requestPermission(); } catch (Exception ignored) {}
                onImage.image(info);
                return true;
            }
        };
    }
}

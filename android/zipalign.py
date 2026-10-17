# zipalign: несжатые файлы (resources.arsc и др.) выравниваем по 4 байта — нужно Android 11+ и подписи v2
import sys, zipfile, struct
src, dst = sys.argv[1], sys.argv[2]
zin = zipfile.ZipFile(src)
with open(dst, 'wb') as f:
    zout = zipfile.ZipFile(f, 'w')
    for info in zin.infolist():
        data = zin.read(info.filename)
        ni = zipfile.ZipInfo(info.filename, date_time=(2026, 1, 1, 0, 0, 0))
        stored = info.compress_type == zipfile.ZIP_STORED or info.filename == 'resources.arsc' or info.filename.endswith('.png')
        ni.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
        ni.external_attr = info.external_attr
        if stored:
            # смещение данных = позиция заголовка + 30 + имя + extra; подбираем extra
            off = f.tell() + 30 + len(ni.filename.encode('utf-8'))
            pad = (4 - off % 4) % 4
            ni.extra = b'\x00' * pad
        zout.writestr(ni, data)
    zout.close()

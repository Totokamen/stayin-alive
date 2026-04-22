import struct, zlib, math

def create_png(size, filename):
    def heart_shape(x, y, s):
        nx = (x - s/2) / (s/2)
        ny = (y - s*0.4) / (s/2)
        return (nx*nx + ny*ny - 1)**3 - nx*nx * ny*ny*ny < 0

    rows = []
    for y in range(size):
        row = b'\x00'
        for x in range(size):
            cx, cy = x + 0.5, y + 0.5
            dist = math.sqrt((cx - size/2)**2 + (cy - size/2)**2)
            if dist > size/2:
                row += b'\x00\x00\x00\x00'
            elif heart_shape(cx, cy, size):
                row += b'\xe7\x4c\x3c\xff'
            else:
                row += b'\x1a\x1a\x1a\xff'
        rows.append(row)

    raw = b''.join(rows)
    compressed = zlib.compress(raw)

    def chunk(ctype, data):
        c = ctype + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', ihdr)
    png += chunk(b'IDAT', compressed)
    png += chunk(b'IEND', b'')

    with open(filename, 'wb') as f:
        f.write(png)

create_png(16, 'icon16.png')
create_png(48, 'icon48.png')
create_png(128, 'icon128.png')
print('done')

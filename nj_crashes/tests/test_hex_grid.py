from nj_crashes.grid.grid import Point, cos, sin, hex


def test_hex_grid():
    assert hex(0) == []

    row0 = [ Point(0, 0) ]
    assert hex(1) == row0

    row1 = [ Point(1, 0), Point(cos, sin), Point(-cos, sin), Point(-1, 0), Point(-cos, -sin), Point(cos, -sin) ]
    assert hex(2) == row0 + row1[:1] # [ Point(1, 0) ]
    assert hex(3) == row0 + row1[:2] # [ Point(1, 0), Point(cos, sin) ]
    assert hex(4) == row0 + row1[:3] # [ Point(1, 0), Point(cos, sin), Point(-cos, sin) ]
    assert hex(5) == row0 + row1[:4] # [ Point(1, 0), Point(cos, sin), Point(-cos, sin), Point(-1, 0) ]
    assert hex(6) == row0 + row1[:5] # [ Point(1, 0), Point(cos, sin), Point(-cos, sin), Point(-1, 0), Point(-cos, -sin) ]
    assert hex(7) == row0 + row1

    row2 = [
        Point(2, 0), Point(2 - cos, sin),
        Point(1, 2*sin), Point(0, 2*sin),
        Point(-1, 2*sin), Point(-1 - cos, sin),
    ]
    row2 = row2 + [ -p for p in row2 ]
    assert hex(8) == row0 + row1 + row2[:1]
    assert hex(9) == row0 + row1 + row2[:2]
    assert hex(10) == row0 + row1 + row2[:3]
    assert hex(11) == row0 + row1 + row2[:4]
    assert hex(12) == row0 + row1 + row2[:5]
    assert hex(13) == row0 + row1 + row2[:6]
    assert hex(14) == row0 + row1 + row2[:7]
    assert hex(15) == row0 + row1 + row2[:8]
    assert hex(16) == row0 + row1 + row2[:9]
    assert hex(17) == row0 + row1 + row2[:10]
    assert hex(18) == row0 + row1 + row2[:11]
    assert hex(19) == row0 + row1 + row2

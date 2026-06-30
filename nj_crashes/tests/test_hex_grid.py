from nj_crashes.grid.hex import Hex, Point, cos, sin


def test_hex_grid():
    assert Hex(0).points == []

    row0 = [ Point(0, 0) ]
    assert Hex(1).points == row0

    row1 = [ Point(1, 0), Point(cos, sin), Point(-cos, sin), Point(-1, 0), Point(-cos, -sin), Point(cos, -sin) ]
    assert Hex(2).points == row0 + row1[:1] # [ Point(1, 0) ]
    assert Hex(3).points == row0 + row1[:2] # [ Point(1, 0), Point(cos, sin) ]
    assert Hex(4).points == row0 + row1[:3] # [ Point(1, 0), Point(cos, sin), Point(-cos, sin) ]
    assert Hex(5).points == row0 + row1[:4] # [ Point(1, 0), Point(cos, sin), Point(-cos, sin), Point(-1, 0) ]
    assert Hex(6).points == row0 + row1[:5] # [ Point(1, 0), Point(cos, sin), Point(-cos, sin), Point(-1, 0), Point(-cos, -sin) ]
    assert Hex(7).points == row0 + row1

    row2 = [
        Point(2, 0), Point(2 - cos, sin),
        Point(1, 2*sin), Point(0, 2*sin),
        Point(-1, 2*sin), Point(-1 - cos, sin),
    ]
    row2 = row2 + [ -p for p in row2 ]
    assert Hex(8).points == row0 + row1 + row2[:1]
    assert Hex(9).points == row0 + row1 + row2[:2]
    assert Hex(10).points == row0 + row1 + row2[:3]
    assert Hex(11).points == row0 + row1 + row2[:4]
    assert Hex(12).points == row0 + row1 + row2[:5]
    assert Hex(13).points == row0 + row1 + row2[:6]
    assert Hex(14).points == row0 + row1 + row2[:7]
    assert Hex(15).points == row0 + row1 + row2[:8]
    assert Hex(16).points == row0 + row1 + row2[:9]
    assert Hex(17).points == row0 + row1 + row2[:10]
    assert Hex(18).points == row0 + row1 + row2[:11]
    assert Hex(19).points == row0 + row1 + row2

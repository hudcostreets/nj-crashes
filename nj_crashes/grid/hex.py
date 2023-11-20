from dataclasses import dataclass
from math import sqrt
from typing import Union
from utz import cached_property


@dataclass
class Point:
    x: float
    y: float

    @property
    def r(self) -> float:
        return sqrt(self.r2)

    @property
    def r2(self) -> float:
        return self.x * self.x + self.y * self.y

    def __add__(self, o: Union['Point', float, int]) -> 'Point':
        if isinstance(o, Point):
            return Point(self.x + o.x, self.y + o.y)
        else:
            return Point(self.x + o, self.y + o)

    def __sub__(self, o: Union['Point', float, int]) -> 'Point':
        if isinstance(o, Point):
            return Point(self.x - o.x, self.y - o.y)
        else:
            return Point(self.x - o, self.y - o)

    def __neg__(self):
        return Point(-self.x, -self.y)

    def __mul__(self, n: float) -> 'Point':
        return Point(self.x * n, self.y * n)

    def __truediv__(self, n: float) -> 'Point':
        return Point(self.x / n, self.y / n)


cos = 0.5
sin = sqrt(3) / 2
vertices = [
    Point(   1,    0),
    Point( cos,  sin),
    Point(-cos,  sin),
    Point(  -1,    0),
    Point(-cos, -sin),
    Point( cos, -sin),
]
num_vertices = len(vertices)


@dataclass
class Hex:
    n: int

    @cached_property
    def points(self) -> list[Point]:
        n = self.n
        if not n:
            return []
        points = [ Point(0, 0) ]
        r = 1
        nr = 6
        i = 1
        ir = 0
        intra_segment_idx = 0
        segment_idx = 0
        segment_start = vertices[segment_idx] * r
        segment_end = vertices[(segment_idx + 1) % num_vertices] * r
        while i < n:
            point = segment_start + (segment_end - segment_start) * (intra_segment_idx / r)
            points.append(point)
            i += 1
            ir += 1
            if ir == nr:
                ir = 0
                r += 1
                nr += 6
                segment_idx = 0
                intra_segment_idx = 0
                segment_start = vertices[segment_idx] * r
                segment_end = vertices[(segment_idx + 1) % num_vertices] * r
            else:
                intra_segment_idx += 1
                if intra_segment_idx == r:
                    intra_segment_idx = 0
                    segment_idx += 1
                    segment_start = vertices[segment_idx] * r
                    segment_end = vertices[(segment_idx + 1) % num_vertices] * r

        return points

@dataclass
class Points:
    points: list[Point]

    @cached_property
    def centroid(self) -> Point:
        points = self.points
        return sum(points) / len(points)

    @cached_property
    def center(self) -> 'Points':
        return self - self.centroid

    @cached_property
    def r(self) -> float:
        return max(p.r for p in self.points)

    def __sub__(self, other: Point):
        return Points([ p - other for p in self.points ])

    def __mul__(self, other: float):
        return Points([ p * other for p in self.points ])

    def __truediv__(self, other: float):
        return Points([ p / other for p in self.points ])

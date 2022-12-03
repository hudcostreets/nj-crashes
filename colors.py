from utz import o
from utz.colors import colors_lengthen
import plotly.express as px


px_colors = px.colors.sequential.Inferno
# print(f"{' '.join(px_colors)} ({len(px_colors)})")


gridcolor = '#ccc'


def get_colors(num_years):
    year_colors = list(reversed(colors_lengthen(px_colors, num_years)))
    # print(f"{' '.join(colors)} ({len(colors)})")

    red = year_colors[len(year_colors) // 2]
    black = year_colors[-1]
    return o(black=black, red=red, year_colors=year_colors,)

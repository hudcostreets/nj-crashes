import plotly.graph_objects as go


PUBLIC_DIR = 'www/public'
PLOTS_DIR = f'{PUBLIC_DIR}/plots'
W, H = 1200, 700  # default plot .png size
MARGIN = { 't': 0, 'r': 25, 'b': 30, 'l': 0, }


def update_layout(fig, title, name, hovermode=None, hovertemplate=None, w=None, h=None, pretty=False, margin=None, dir=None, **kwargs):
    dir = dir or PLOTS_DIR
    fig.update_layout(
        paper_bgcolor='white',
        plot_bgcolor='white',
        hovermode=hovermode,
        **kwargs,
    )
    if hovermode or hovertemplate:
        fig.update_traces(hovertemplate=hovertemplate)

    # Don't include the title in the saved figure
    saved = go.Figure(fig)
    saved.write_image(f'{PLOTS_DIR}/{name}.png', width=w, height=h,)
    saved.write_json(f'{PLOTS_DIR}/{name}.json', pretty=pretty)
    saved.update_layout(margin=margin or MARGIN)

    fig.update_layout(title=title, title_x=0.5)
    return fig


def save(fig, title, name, bg=None, hoverx=False, png_title=False, gridcolor=None, pretty=False, margin=None, dir=None, w=W, h=H, **layout):
    dir = dir or PLOTS_DIR
    if bg:
        layout['plot_bgcolor'] = 'white'
        layout['paper_bgcolor'] = 'white'
    if hoverx:
        layout['hovermode'] = 'x'
        fig.update_traces(hovertemplate=None)
    if gridcolor:
        fig.update_xaxes(
            gridcolor=gridcolor,
        ).update_yaxes(
            gridcolor=gridcolor,
        )
    title_layout = dict(title=title, title_x=0.5)
    if png_title:
        layout.update(title_layout)
    fig.update_layout(**layout)
    fig.update_yaxes(rangemode='tozero')
    rv = go.Figure(fig)
    if not png_title:
        # only need to do this if it wasn't already done above
        rv.update_layout(**title_layout)

    fig.update_layout(margin=margin or MARGIN)
    fig.update_yaxes(title='')
    fig.write_json(f'{PLOTS_DIR}/{name}.json', pretty=pretty)
    fig.write_image(f'{PLOTS_DIR}/{name}.png', width=w, height=h)

    return rv

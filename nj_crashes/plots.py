from os.path import dirname

import plotly.graph_objects as go

PKG_DIR = dirname(__file__)
ROOT_DIR = dirname(PKG_DIR)
WWW_DIR = f'{ROOT_DIR}/www'
PUBLIC_DIR = f'{WWW_DIR}/public'
PLOTS_DIR = f'{PUBLIC_DIR}/plots'
RUNDATE_PATH = f'{PUBLIC_DIR}/rundate.json'
DB_PATH = f'{ROOT_DIR}/njsp.db'
DB_URI = f'sqlite:///{DB_PATH}'
DEFAULT_MARGIN = { 't': 0, 'r': 25, 'b': 0, 'l': 0, }


def save(
        fig, title, name,
        bg=None, hoverx=False, hovertemplate=None, png_title=False,
        yrange='tozero', bottom_legend='all',
        pretty=False, margin=None,
        dir=None, w=None, h=None,
        xtitle=None, ytitle=None, ltitle=None,
        xgrid=None, ygrid=None,
        **layout,
):
    dir = dir or PLOTS_DIR
    bottom_legend_kwargs = dict(
        orientation='h',
        x=0.5,
        xanchor='center',
        yanchor='top',
    )
    layout['xaxis_title'] = layout.get('xaxis_title', xtitle or '')
    layout['yaxis_title'] = layout.get('yaxis_title', ytitle or '')
    layout['legend_title'] = layout.get('legend_title', ltitle or '')
    if bg:
        layout['plot_bgcolor'] = 'white'
        layout['paper_bgcolor'] = 'white'
    if hoverx:
        layout['hovermode'] = 'x'
        fig.update_traces(hovertemplate=hovertemplate)
    elif hovertemplate:
        fig.update_traces(hovertemplate=hovertemplate)
    if yrange:
        layout['yaxis_rangemode'] = yrange
    if bottom_legend == 'all':
        if 'legend' not in layout:
            layout['legend'] = {}
        layout['legend'].update(**bottom_legend_kwargs)
    if xgrid:
        fig.update_xaxes(gridcolor=xgrid,)
    if ygrid:
        fig.update_yaxes(gridcolor=ygrid,)
    title_layout = dict(title=title, title_x=0.5)
    if png_title:
        layout.update(title_layout)
    fig.update_layout(**layout)
    fig.update_yaxes(rangemode='tozero')
    saved = go.Figure(fig)
    if not png_title:
        # only need to do this if it wasn't already done above
        fig.update_layout(**title_layout)

    if bottom_legend is True:
        saved.update_layout(
            legend=bottom_legend_kwargs,
        )
    saved.update_layout(margin=margin or DEFAULT_MARGIN)
    saved.write_json(f'{dir}/{name}.json', pretty=pretty)
    saved.write_image(f'{dir}/{name}.png', width=w, height=h)

    return fig

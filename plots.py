PUBLIC_DIR = 'www/public'
PLOTS_DIR = f'{PUBLIC_DIR}/plots'


def update_layout(fig, title, name, hovermode=None, hovertemplate=None, width=None, height=None, **kwargs):
    fig.update_layout(
        paper_bgcolor='white',
        plot_bgcolor='white',
        title=title,
        title_x=0.5,
        hovermode=hovermode,
        **kwargs,
    )
    if hovermode or hovertemplate:
        fig.update_traces(hovertemplate=hovertemplate)
    fig.write_image(f'{PUBLIC_DIR}/{name}.png', width=width, height=height,)
    fig.write_json(f'{PLOTS_DIR}/{name}.json', pretty=True)
    return fig

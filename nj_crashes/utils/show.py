from IPython.core.display import Image


interactive = False
def show(fig, i=False, w=1000, h=600):
    global interactive
    return fig if interactive or i else Image(fig.to_image(width=w, height=h))

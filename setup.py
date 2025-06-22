from setuptools import setup

setup(
    name="nj_crashes",
    install_requires=open("requirements.txt", "r").read(),
    packages=[ "crime", "nj_crashes", "njsp", "njdot", ],
    entry_points={
        'console_scripts': [
            'njsp=njsp.cli.main:main',
            'njdot=njdot.cli.main:main',
        ],
    }
)

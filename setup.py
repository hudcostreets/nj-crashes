from setuptools import setup, find_packages

setup(
    name="nj_crashes",
    install_requires=open("requirements.txt", "r").read(),
    packages=find_packages(),
    entry_points={
        'console_scripts': [
            'njsp=njsp.cli.main:main',
        ],
    }
)

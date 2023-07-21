from setuptools import setup, find_packages

setup(
    name="nj_crashes_pub",
    install_requires=open("requirements.txt", "r").read(),
    packages=find_packages(),
    entry_points='''
        [console_scripts]
        commit-crashes=nj_crashes.commit_crashes:main
    ''',
)

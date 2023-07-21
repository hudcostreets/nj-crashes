from setuptools import setup, find_packages

packages = find_packages()
print(f'packages: {packages}')

setup(
    name="nj_crashes",
    install_requires=open("requirements.txt", "r").read(),
    packages=packages,
    entry_points='''
        [console_scripts]
        commit_crashes=nj_crashes.commit_crashes:main
    ''',
)

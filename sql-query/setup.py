from setuptools import setup

setup(
    name="sql-query",
    install_requires=open("requirements.txt", "r").read(),
    packages=[ "sql_query", ],
    entry_points={
        'console_scripts': [
            'sql-query=sql_query.main:main',
        ],
    }
)

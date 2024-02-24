import click

njobs_opt = click.option('-j', '--num-jobs', 'n_jobs', type=int, default=0, help='Number of jobs to run in parallel')

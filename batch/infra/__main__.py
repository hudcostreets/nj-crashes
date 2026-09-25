"""nj-crashes AWS Batch + Fargate infra (see specs/reproc-infra-iac.md).

Owns the `nj-crashes-*` namespace declaratively so `dvx.batch.submit(
prefix='nj-crashes')` can run reproc/audit jobs against it with NO `bootstrap`
call and NO baked static creds (the container runs as a task role). Resource
names mirror `dvx.batch`'s `prefix='nj-crashes'` derivation exactly, so submit
finds them.
"""
import json
from pathlib import Path

import pulumi
import pulumi_aws as aws
import pulumi_docker_build as docker_build

cfg = pulumi.Config()
REGION = aws.config.region or "us-east-1"
PREFIX = "nj-crashes"
BUCKET = "nj-crashes"                     # dvx remote + scratch live here
VCPU = cfg.get("vcpu") or "16"
MEMORY_MIB = cfg.get("memory_mib") or "65536"
GH_TOKEN_SECRET_ARN = cfg.get("gh_token_secret_arn")  # reproc push-back only
# One Batch job definition per entry, keyed by name (= the `prefix` that
# `batch/submit -d` passes to `dvx.batch.submit`). Each has an `arch` and
# either a `ref` (git SHA on GitHub: Pulumi builds + pushes the image from
# `batch/Dockerfile`) or a prebuilt `image` URI; `gh_token: true` injects the
# GH push-back token. All share the `nj-crashes` queue and roles.
JOBDEFS: dict[str, dict] = cfg.require_object("jobdefs")
BATCH_DIR = Path(__file__).resolve().parent.parent
PLATFORMS = {
    "ARM64": (docker_build.Platform.LINUX_ARM64, "arm64"),
    "X86_64": (docker_build.Platform.LINUX_AMD64, "amd64"),
}

# --- Default-VPC networking (matches dvx.batch; dedicated VPC is a later hardening) ---
default_vpc = aws.ec2.get_vpc(default=True)
subnets = aws.ec2.get_subnets(filters=[aws.ec2.GetSubnetsFilterArgs(
    name="vpc-id", values=[default_vpc.id])])
default_sg = aws.ec2.get_security_group(vpc_id=default_vpc.id, name="default")

ECS_TASKS_TRUST = json.dumps({
    "Version": "2012-10-17",
    "Statement": [{
        "Effect": "Allow",
        "Principal": {"Service": "ecs-tasks.amazonaws.com"},
        "Action": "sts:AssumeRole",
    }],
})

# --- Execution role: ECS agent (image pull + logs + read the injected secret) ---
execution_role = aws.iam.Role(
    "execution-role",
    name="nj-crashes-batch-execution",
    assume_role_policy=ECS_TASKS_TRUST,
)
aws.iam.RolePolicyAttachment(
    "execution-ecs-policy",
    role=execution_role.name,
    policy_arn="arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
)
if GH_TOKEN_SECRET_ARN:
    aws.iam.RolePolicy(
        "execution-secrets-policy",
        role=execution_role.id,
        policy=json.dumps({
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Action": "secretsmanager:GetSecretValue",
                "Resource": GH_TOKEN_SECRET_ARN,
            }],
        }),
    )

# --- Task role: the identity the CONTAINER runs as. Scoped S3 → no static keys ---
task_role = aws.iam.Role(
    "task-role",
    name="nj-crashes-batch-task",
    assume_role_policy=ECS_TASKS_TRUST,
)
aws.iam.RolePolicy(
    "task-s3-policy",
    role=task_role.id,
    policy=json.dumps({
        "Version": "2012-10-17",
        "Statement": [
            {"Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
             "Resource": f"arn:aws:s3:::{BUCKET}"},
            {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"],
             "Resource": f"arn:aws:s3:::{BUCKET}/*"},
        ],
    }),
)

# --- ECR repo. Pre-existed this stack (created by the manual-build era), so it's
#     imported rather than created, and protected so no `pulumi` op deletes the
#     images in it. ---
repo = aws.ecr.Repository(
    "repo",
    name="nj-crashes-reproc",
    image_tag_mutability="MUTABLE",
    image_scanning_configuration=aws.ecr.RepositoryImageScanningConfigurationArgs(scan_on_push=False),
    encryption_configurations=[aws.ecr.RepositoryEncryptionConfigurationArgs(encryption_type="AES256")],
    opts=pulumi.ResourceOptions(import_="nj-crashes-reproc", protect=True),
)
ecr_auth = aws.ecr.get_authorization_token_output(registry_id=repo.registry_id)

# --- Compute environment (Fargate Spot). Service-linked role AWSServiceRoleForBatch
#     is auto-used; no instance role for Fargate. ---
compute_env = aws.batch.ComputeEnvironment(
    "spot",
    compute_environment_name="nj-crashes-spot",
    type="MANAGED",
    compute_resources=aws.batch.ComputeEnvironmentComputeResourcesArgs(
        type="FARGATE_SPOT",
        max_vcpus=16,
        subnets=subnets.ids,
        security_group_ids=[default_sg.id],
    ),
)

# --- Job queue (spot). Name == prefix, so submit(prefix='nj-crashes') targets it ---
queue = aws.batch.JobQueue(
    "spot",
    name="nj-crashes",
    state="ENABLED",
    priority=1,
    compute_environment_orders=[aws.batch.JobQueueComputeEnvironmentOrderArgs(
        order=1, compute_environment=compute_env.arn)],
)


def _container_props(args: dict) -> str:
    env = [{"name": "PYTHONFAULTHANDLER", "value": "1"}]
    props = {
        "image": args["image"],
        "runtimePlatform": {"operatingSystemFamily": "LINUX", "cpuArchitecture": args["arch"]},
        "resourceRequirements": [
            {"type": "VCPU", "value": VCPU},
            {"type": "MEMORY", "value": MEMORY_MIB},
        ],
        "executionRoleArn": args["exec_arn"],
        "jobRoleArn": args["task_arn"],       # ← the container's identity; no AWS_* env
        "environment": env,
        "networkConfiguration": {"assignPublicIp": "ENABLED"},
        "fargatePlatformConfiguration": {"platformVersion": "LATEST"},
        "ephemeralStorage": {"sizeInGiB": 100},
        "logConfiguration": {
            "logDriver": "awslogs",
            "options": {
                "awslogs-group": args["log_group"],
                "awslogs-region": REGION,
                "awslogs-stream-prefix": PREFIX,
            },
        },
    }
    if args["gh_token"]:
        if not GH_TOKEN_SECRET_ARN:
            raise ValueError("a jobdef sets `gh_token: true` but `gh_token_secret_arn` is unset")
        props["secrets"] = [{"name": "FARGATE_GITHUB_RW_TOKEN", "valueFrom": GH_TOKEN_SECRET_ARN}]
    return json.dumps(props)


def _image(name: str, spec: dict, arch: str) -> pulumi.Input[str]:
    """The jobdef's image URI: a prebuilt `image`, or one built from `ref`."""
    if ("ref" in spec) == ("image" in spec):
        raise ValueError(f"jobdef {name}: set exactly one of `ref` / `image`")
    if "image" in spec:
        return spec["image"]
    ref = spec["ref"]
    platform, arch_tag = PLATFORMS[arch]
    image = docker_build.Image(
        f"image-{name}",
        context=docker_build.BuildContextArgs(location=str(BATCH_DIR)),
        platforms=[platform],
        build_args={"REF": ref},
        tags=[repo.repository_url.apply(lambda url: f"{url}:{ref[:11]}-{arch_tag}")],
        push=True,
        registries=[docker_build.RegistryArgs(
            address=repo.repository_url,
            username=ecr_auth.user_name,
            password=ecr_auth.password,
        )],
    )
    # `ref` is `<repo>:<tag>@sha256:…`: pins the job def to the exact digest.
    return image.ref


# --- Job definitions: one per `jobdefs` entry; name == the submit `prefix`, and
#     `dvx.batch.submit` reads logs from `/<prefix>/batch`. The `nj-crashes`
#     entry keeps its original resource names so existing state isn't replaced. ---
job_defs = {}
for name, spec in JOBDEFS.items():
    arch = spec["arch"]
    suffix = "" if name == PREFIX else f"-{name}"
    log_group = aws.cloudwatch.LogGroup(
        f"log-group{suffix}",
        name=f"/{name}/batch",
        retention_in_days=30,
    )
    job_defs[name] = aws.batch.JobDefinition(
        f"jobdef{suffix}",
        name=name,
        type="container",
        platform_capabilities=["FARGATE"],
        # Fargate Spot reclaims are frequent; retry on interruption, exit on any
        # genuine failure (so a real bug doesn't burn attempts).
        retry_strategy=aws.batch.JobDefinitionRetryStrategyArgs(
            attempts=3,
            evaluate_on_exits=[
                aws.batch.JobDefinitionRetryStrategyEvaluateOnExitArgs(
                    action="RETRY", on_status_reason="Your Spot Task*"),   # Spot reclaim
                aws.batch.JobDefinitionRetryStrategyEvaluateOnExitArgs(
                    action="EXIT", on_reason="*"),
            ],
        ),
        container_properties=pulumi.Output.all(
            image=_image(name, spec, arch),
            arch=arch,
            gh_token=bool(spec.get("gh_token")),
            log_group=log_group.name,
            exec_arn=execution_role.arn,
            task_arn=task_role.arn,
        ).apply(_container_props),
    )

pulumi.export("queue", queue.name)
pulumi.export("job_definitions", {name: jd.arn for name, jd in job_defs.items()})
pulumi.export("execution_role_arn", execution_role.arn)
pulumi.export("task_role_arn", task_role.arn)

"""nj-crashes AWS Batch + Fargate infra (see specs/reproc-infra-iac.md).

Owns the `nj-crashes-*` namespace declaratively so `dvx.batch.submit(
prefix='nj-crashes')` can run reproc/audit jobs against it with NO `bootstrap`
call and NO baked static creds (the container runs as a task role). Resource
names mirror `dvx.batch`'s `prefix='nj-crashes'` derivation exactly, so submit
finds them.
"""
import json

import pulumi
import pulumi_aws as aws

cfg = pulumi.Config()
REGION = aws.config.region or "us-east-1"
BUCKET = "nj-crashes"                     # dvx remote + scratch live here
IMAGE = cfg.require("image")              # full ECR URI:tag; set per run via `pulumi up -c ...:image=`
ARCH = cfg.get("arch") or "ARM64"        # ARM64 (reproc) | X86_64 (audit)
VCPU = cfg.get("vcpu") or "16"
MEMORY_MIB = cfg.get("memory_mib") or "65536"
GH_TOKEN_SECRET_ARN = cfg.get("gh_token_secret_arn")  # reproc push-back only

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

# --- Log group ---
log_group = aws.cloudwatch.LogGroup(
    "log-group",
    name="/nj-crashes/batch",
    retention_in_days=30,
)

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
        "runtimePlatform": {"operatingSystemFamily": "LINUX", "cpuArchitecture": ARCH},
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
                "awslogs-group": "/nj-crashes/batch",
                "awslogs-region": REGION,
                "awslogs-stream-prefix": "nj-crashes",
            },
        },
    }
    if GH_TOKEN_SECRET_ARN:
        props["secrets"] = [{"name": "FARGATE_GITHUB_RW_TOKEN", "valueFrom": GH_TOKEN_SECRET_ARN}]
    return json.dumps(props)


# --- Job definition. Name == prefix. Image/arch from config → `pulumi up -c image=` per run ---
job_def = aws.batch.JobDefinition(
    "jobdef",
    name="nj-crashes",
    type="container",
    platform_capabilities=["FARGATE"],
    container_properties=pulumi.Output.all(
        image=IMAGE, exec_arn=execution_role.arn, task_arn=task_role.arn,
    ).apply(_container_props),
)

pulumi.export("queue", queue.name)
pulumi.export("job_definition", job_def.name)
pulumi.export("execution_role_arn", execution_role.arn)
pulumi.export("task_role_arn", task_role.arn)
pulumi.export("image", IMAGE)
pulumi.export("arch", ARCH)

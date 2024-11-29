# "git" or "local"
ARG src=git

FROM node:22-slim AS local
COPY www/ /src/www/
COPY njsp/ /src/njsp/

FROM node:22-slim AS git
ENV PATH="/opt/venv/bin:$PATH"
RUN apt update -y \
 && apt-get install -y git python3 python3-pip python3-dev python3-venv wget \
 && python3 -m venv /opt/venv \
 && pip install -U pip \
 && pip install dvc-s3
ARG cache=0
RUN git clone --depth 1 -b server https://github.com/hudcostreets/nj-crashes src
WORKDIR /src/www/public/njdot
RUN --mount=type=secret,id=aws,target=/root/.aws/credentials \
    dvc pull cmymc.db crashes.db drivers.db occupants.db pedestrians.db vehicles.db
WORKDIR /src/www/public/njsp
RUN wget https://nj-crashes.s3.amazonaws.com/njsp/data/crashes.db

FROM ${src} AS src

FROM node:22-slim AS build
RUN apt update -y \
 && apt-get install -y htop \
 && apt-get clean \
 && npm i -g pnpm
COPY --from=src /src /src
WORKDIR /src/www
RUN pnpm i
RUN npm run build
ENTRYPOINT [ "npm", "run", "start", "--", "--port", "8080" ]

from dataclasses import dataclass, field


@dataclass
class Reply:
    ts: str
    text: str


@dataclass
class Thread:
    ts: str
    text: str
    replies: list['Reply'] = field(default_factory=list)

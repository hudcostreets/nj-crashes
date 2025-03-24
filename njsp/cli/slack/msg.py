from dataclasses import dataclass, field


@dataclass
class Msg:
    ts: str
    text: str


@dataclass
class Thread(Msg):
    replies: list[Msg] = field(default_factory=list)

    @property
    def msgs(self) -> list[Msg]:
        """Return all messages in the thread, including the original message."""
        return [self] + self.replies

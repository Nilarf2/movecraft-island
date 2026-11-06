"""Errors that become {"error": {"code", "message"}} responses."""


class ApiError(Exception):
    """status: HTTP status; code: stable string for the client; message: Chinese, shown to players."""

    def __init__(self, status, code, message, retry_after=None, **extra):
        super().__init__(code)
        self.status, self.code, self.message = status, code, message
        self.retry_after, self.extra = retry_after, extra


class Busy(Exception):
    """Too many password hashes waiting; the client should retry shortly."""

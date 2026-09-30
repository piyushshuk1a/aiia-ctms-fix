"""Server-only configuration. No secrets or credentials are compiled into browser assets."""
from dataclasses import dataclass, field
from pathlib import Path
import os
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
def flag(name: str, default=False):
    return os.getenv(name, str(default)).lower() in ('true', '1', 'yes')

@dataclass
class Settings:
    secret: str = field(default_factory=lambda: os.getenv('AUTH_SECRET', ''))
    database: str = field(default_factory=lambda: os.getenv('DATABASE_PATH', str(ROOT / 'runtime' / 'ayusetu.sqlite3')))
    origin: str = field(default_factory=lambda: os.getenv('APP_ORIGIN', 'http://127.0.0.1:5173').rstrip('/'))
    demo_mode: bool = field(default_factory=lambda: flag('DEMO_MODE'))
    isolated_synthetic: bool = field(default_factory=lambda: flag('ISOLATED_SYNTHETIC'))
    cookie_secure: bool = field(default_factory=lambda: flag('COOKIE_SECURE'))
    access_seconds: int = field(default_factory=lambda: int(os.getenv('ACCESS_SECONDS', '900')))
    session_seconds: int = field(default_factory=lambda: int(os.getenv('SESSION_SECONDS', '28800')))
    idle_seconds: int = field(default_factory=lambda: int(os.getenv('IDLE_SECONDS', '1800')))
    remembered_seconds: int = field(default_factory=lambda: int(os.getenv('REMEMBERED_SECONDS', '604800')))
    otp_seconds: int = field(default_factory=lambda: int(os.getenv('OTP_SECONDS', '300')))
    otp_attempts: int = 5
    otp_resend_seconds: int = field(default_factory=lambda: int(os.getenv('OTP_RESEND_SECONDS', '30')))
    reset_seconds: int = field(default_factory=lambda: int(os.getenv('RESET_SECONDS', '900')))
    otp_roles: tuple = field(default_factory=lambda: tuple(x.strip() for x in os.getenv('OTP_ROLES', 'Admin,PV').split(',') if x.strip()))
    login_limit: int = 5
    ip_login_limit: int = 60
    rate_window: int = 900
    retry_delay_scale: float = 1.0
    smtp_host: str = field(default_factory=lambda: os.getenv('SMTP_HOST', ''))
    smtp_port: int = field(default_factory=lambda: int(os.getenv('SMTP_PORT', '587')))
    smtp_user: str = field(default_factory=lambda: os.getenv('SMTP_USER', ''))
    smtp_password: str = field(default_factory=lambda: os.getenv('SMTP_PASSWORD', ''))
    smtp_sender: str = field(default_factory=lambda: os.getenv('SMTP_SENDER', ''))

    def validate(self):
        if len(self.secret) < 32:
            raise RuntimeError('Set AUTH_SECRET to a randomly generated server-only secret of at least 32 characters. Run python scripts/init_env.py for an isolated demo.')
        if self.demo_mode and not self.isolated_synthetic:
            raise RuntimeError('DEMO_MODE requires ISOLATED_SYNTHETIC=true. Never enable demo accounts for real data.')
        try:
            origin = urlsplit(self.origin)
            port = origin.port
        except ValueError as exc:
            raise RuntimeError('APP_ORIGIN must be a valid explicit http(s) origin.') from exc
        if origin.scheme not in ('http', 'https') or not origin.hostname or origin.username or origin.password or origin.path not in ('', '/') or origin.query or origin.fragment:
            raise RuntimeError('APP_ORIGIN must contain only scheme, hostname, and optional port; no credentials, paths, query, or fragment.')
        if origin.scheme == 'https' and not self.cookie_secure:
            raise RuntimeError('HTTPS requires COOKIE_SECURE=true.')
        if origin.scheme == 'http' and (origin.hostname not in ('127.0.0.1', 'localhost', '::1') or not port):
            raise RuntimeError('Non-loopback deployments require HTTPS and secure cookies. Local HTTP needs an explicit port.')
        if not set(self.otp_roles).issubset({'PI','Coordinator','Monitor','Ethics','PV','Admin','Regulator'}):
            raise RuntimeError('OTP_ROLES contains an unknown role.')
        for value in (self.access_seconds, self.session_seconds, self.idle_seconds, self.remembered_seconds, self.otp_seconds, self.otp_resend_seconds, self.reset_seconds):
            if value <= 0:
                raise RuntimeError('Authentication expiry values must be positive.')
        return self

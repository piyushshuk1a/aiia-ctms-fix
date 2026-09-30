"""Single-process local runner; secrets come from .env/environment, not source defaults."""
import os
from pathlib import Path
from urllib.parse import urlsplit
from .config import ROOT

def load_env():
    env=ROOT/'.env'
    if env.exists():
        for line in env.read_text().splitlines():
            line=line.strip()
            if line and not line.startswith('#') and '=' in line:
                key,value=line.split('=',1)
                os.environ.setdefault(key,value.strip().strip('"').strip("'"))

if __name__=='__main__':
    load_env()
    import uvicorn
    from .app import create_app
    origin=urlsplit(os.getenv('APP_ORIGIN','http://127.0.0.1:5173'))
    app=create_app()
    # Avoid credential-bearing paths in access logs; resets use fragments, not query strings.
    uvicorn.run(app,host=os.getenv('BIND_HOST','127.0.0.1'),port=origin.port or 5173,access_log=False,proxy_headers=False,workers=1)

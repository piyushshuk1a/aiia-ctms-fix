"""Create an isolated-demo .env once. Does not overwrite secrets or database state."""
from pathlib import Path
import secrets, os
root=Path(__file__).resolve().parents[1];path=root/'.env'
if path.exists():
    print('.env already exists; left unchanged.')
else:
    text=(root/'.env.example').read_text().replace('AUTH_SECRET=\n','AUTH_SECRET='+secrets.token_urlsafe(48)+'\n')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:f.write(text)
    print('Created .env with a new server-only secret and isolated synthetic demo configuration.')

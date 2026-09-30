# Third-party runtime notices

This prototype includes these locally available browser runtimes:

- `vendor/react.min.js`: React 16.0.0, Copyright (c) 2013-present, Facebook, Inc. Its embedded header identifies the MIT license.
- `vendor/react-dom.min.js`: ReactDOM 16.0.1, Copyright (c) 2013-present, Facebook, Inc. Its embedded header identifies the MIT license and also retains a Modernizr 3.0.0pre custom-build MIT notice.

The original embedded notices are retained in the vendor files. The accompanying MIT license text is in `vendor/LICENSE-MIT.txt`.

These legacy versions were used because the build environment could not download packages. They are provided for this local synthetic-data demonstration, not as a recommended production dependency selection. Upgrade and review runtime dependencies before continued product engineering.

TypeScript 5.8.3 is used as a development compiler and is not embedded as an application runtime. Its package is not redistributed in this archive. System fonts are used; no font files are redistributed.


## Backend and test dependencies

The backend installs FastAPI 0.128.2, Starlette 0.50.0, Uvicorn 0.48.0, argon2-cffi 25.1.0, itsdangerous 2.2.0 and Pydantic 2.13.4 using `requirements.txt`. Python dependency packages are not redistributed in this archive. Their package distributions supply their respective licenses and transitive dependency notices.

Tests use pytest 9.0.2, HTTPX 0.28.1 and Playwright 1.57.0; these packages and the Chromium browser are not included. No authentication provider service, email provider account or font file is redistributed.

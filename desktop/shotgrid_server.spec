# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

REPO_ROOT = Path.cwd().resolve()
SERVER_ENTRY = REPO_ROOT / 'server' / 'shotgrid_server.py'

a = Analysis(
    [str(SERVER_ENTRY)],
    pathex=[str(REPO_ROOT / 'server')],
    binaries=[],
    datas=[],
    hiddenimports=['sqlcipher3'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='shotgrid_server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

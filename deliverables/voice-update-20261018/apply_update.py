"""Validate all inputs, back up, and install this update without restarting services."""
import argparse
import ast
from datetime import datetime
import hashlib
import json
from pathlib import Path
import shutil

ROOT=Path(__file__).resolve().parent

def digest(text):
    return hashlib.sha256(text.replace('\r\n','\n').rstrip('\n').encode()).hexdigest()

def plan(backend,asr):
    expected=json.loads((ROOT/'baseline.json').read_text(encoding='utf-8'))
    entries=[]
    for name,baseline in expected.items():
        area,relative=name.split('/',1)
        target=(backend if area=='backend' else asr)/relative
        source=ROOT/'updated'/('backend/voice-agent' if area=='backend' else 'asr')/relative
        content=source.read_text(encoding='utf-8')
        ast.parse(content,filename=str(source))
        if target.is_file():
            actual=digest(target.read_text(encoding='utf-8-sig'))
            if actual==digest(content):
                print('Already updated:',target)
                continue
            if actual!=baseline:
                raise ValueError(f'Unrecognized existing version; no files written: {target}. Review update.patch instead.')
        elif baseline is not None:
            raise ValueError(f'Required file missing; no files written: {target}')
        if not target.parent.is_dir():
            raise ValueError(f'Destination folder missing: {target.parent}')
        entries.append((name,source,target))
    return entries

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend',required=True,type=Path,help='Directory containing door_backend')
    parser.add_argument('--asr',required=True,type=Path,help='Directory containing kotoba_server.py')
    parser.add_argument('--apply',action='store_true',help='Write after validation; default is read-only')
    args=parser.parse_args()
    entries=plan(args.backend.resolve(),args.asr.resolve())
    for name,source,target in entries: print('Update:',target)
    if not args.apply:
        print('Read-only check complete. Stop Agent and Kotoba ASR, then add --apply.')
        return
    if not entries:
        print('No changes needed.'); return
    backup=args.backend.resolve()/('voice-update-backup-'+datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    backup.mkdir()
    restored=[]
    for name,source,target in entries:
        if target.exists():
            saved=backup/name; saved.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(target,saved)
            restored.append({'target':str(target),'backup':str(saved)})
    (backup/'restore.json').write_text(json.dumps(restored,ensure_ascii=False,indent=2),encoding='utf-8')
    try:
        for name,source,target in entries:
            temporary=target.with_suffix('.voice-update.tmp')
            shutil.copyfile(source,temporary); temporary.replace(target)
    except OSError:
        for item in restored: shutil.copy2(item['backup'],item['target'])
        raise
    print('Installed. Backup:',backup)
    print('Restart Kotoba ASR and Door Agent with their existing launch settings. API/TTS/LiveKit settings unchanged.')

if __name__=='__main__':
    try: main()
    except (OSError,ValueError) as error: raise SystemExit(str(error))

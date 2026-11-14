import importlib.util
import json
from pathlib import Path
import sys
import pytest
spec=importlib.util.spec_from_file_location('apply_update',Path(__file__).parents[1]/'apply_update.py')
update=importlib.util.module_from_spec(spec);spec.loader.exec_module(update)

@pytest.fixture
def setup_update(tmp_path,monkeypatch):
    package=tmp_path/'package'; backend=tmp_path/'backend'; asr=tmp_path/'asr'
    (package/'updated/backend/voice-agent/door_backend').mkdir(parents=True)
    (package/'updated/asr').mkdir(parents=True)
    (backend/'door_backend').mkdir(parents=True);asr.mkdir()
    baseline={}
    for name in ['backend/door_backend/agent.py','asr/kotoba_server.py','asr/kotoba_decoding.py']:
        area,rel=name.split('/',1)
        source=package/'updated'/('backend/voice-agent' if area=='backend' else 'asr')/rel
        source.write_text('value = 2\n')
        baseline[name]=None if rel=='kotoba_decoding.py' else update.digest('value = 1\n')
        if baseline[name]: ((backend if area=='backend' else asr)/rel).write_text('value = 1\r\n')
    (package/'baseline.json').write_text(json.dumps(baseline))
    monkeypatch.setattr(update,'ROOT',package)
    return package,backend,asr

def test_read_only_and_unknown_version_preserve_all_files(setup_update):
    package,backend,asr=setup_update
    assert len(update.plan(backend,asr))==3
    assert '1' in (backend/'door_backend/agent.py').read_text()
    (asr/'kotoba_server.py').write_text('custom = 3\n')
    with pytest.raises(ValueError,match='Unrecognized'):
        update.plan(backend,asr)
    assert '1' in (backend/'door_backend/agent.py').read_text()
    assert not (asr/'kotoba_decoding.py').exists()

def test_apply_backups_and_idempotence(setup_update,monkeypatch):
    package,backend,asr=setup_update
    monkeypatch.setattr(sys,'argv',['apply_update.py','--backend',str(backend),'--asr',str(asr),'--apply'])
    update.main()
    assert '2' in (backend/'door_backend/agent.py').read_text()
    assert (asr/'kotoba_decoding.py').exists()
    backup=next(backend.glob('voice-update-backup-*'))
    entries=json.loads((backup/'restore.json').read_text())
    assert len(entries)==2
    assert all('1' in Path(item['backup']).read_text() for item in entries)
    assert update.plan(backend,asr)==[]

def test_missing_required_file_prevents_write(setup_update):
    package,backend,asr=setup_update
    (asr/'kotoba_server.py').unlink()
    with pytest.raises(ValueError,match='Required file missing'):
        update.plan(backend,asr)

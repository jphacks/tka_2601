import importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('kotoba_decoding',Path(__file__).parents[1]/'updated/asr/kotoba_decoding.py')
decoding=importlib.util.module_from_spec(spec); spec.loader.exec_module(decoding)

class Tensor:
    def __init__(self, size): self.size=size; self.device=None
    def __len__(self): return self.size
    def to(self, device): self.device=device; return self
class Tokenizer:
    def __init__(self, multiplier=1): self.hints=[]; self.multiplier=multiplier
    def get_prompt_ids(self,hint,return_tensors):
        assert return_tensors=='pt'
        self.hints.append(hint)
        return Tensor(1+len(hint)*self.multiplier)

def test_domain_hint_is_encoded_on_device():
    tokenizer=Tokenizer()
    opts=decoding.decoding_options(tokenizer,' 宅配便、荷物、玄関前 ')
    assert tokenizer.hints==['宅配便、荷物、玄関前']
    assert opts['prompt_ids'].device=='cuda:0'
    assert opts['num_beams']==3 and opts['do_sample'] is False
    assert opts['language']=='ja' and opts['max_new_tokens']==256

def test_prompt_and_search_are_bounded():
    tokenizer=Tokenizer(3)
    opts=decoding.decoding_options(tokenizer,'荷物'*500,beams=100)
    assert len(tokenizer.hints[0])==200
    assert len(opts['prompt_ids'])<=223
    assert opts['num_beams']==5

def test_empty_hint_and_request_isolation():
    tokenizer=Tokenizer()
    decoding.decoding_options(tokenizer,'宅配便')
    opts=decoding.decoding_options(tokenizer,'  ',beams=0)
    assert 'prompt_ids' not in opts and opts['num_beams']==1
    assert tokenizer.hints==['宅配便']

#!/usr/bin/env python3
"""Synthetic admission contracts; no native compiler, container, or network execution."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import preflight


class CompatibilityContracts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name).resolve()
        self.root, self.work, self.payload = base/'task', base/'work', base/'recipe/app/compatibility'
        self.source = self.root/'source'
        self.commit, self.tree = '1'*40, '2'*40
        shutil.copytree(HERE/'compatibility', self.payload)
        self.binding = preflight.load(self.payload/'source-binding.json')
        self.binding.update(status='bound-reviewed-r4-cut', sourceCommit=self.commit, sourceTree=self.tree)
        for name in self.binding['sourceOwners']:
            self.put(self.source/name, 'synthetic owner '+name)
            self.binding['sourceOwners'][name] = preflight.sha(self.source/name)
        self.put(self.source/'dist/main.js', 'export const main = 1;')
        self.put(self.source/'dist/build-info.json', {'commit':self.commit})
        selection = self.root/'admission-inputs/plugins/desktop.json'
        self.put(selection, ['synthetic'])
        parser = self.source/'node_modules/.pnpm/typescript@6.0.3/node_modules/typescript'
        self.put(parser/'package.json', {'version':'6.0.3'})
        self.put(parser/'lib/typescript.js', 'synthetic classic parser')
        self.binding['typescript'] = {'relativePath':str(parser.relative_to(self.source)), 'version':'6.0.3',
            'manifestSha256':preflight.sha(parser/'package.json'), 'entrySha256':preflight.sha(parser/'lib/typescript.js')}
        self.put(self.payload/'source-binding.json', self.binding)
        node = self.root/'opt/node/bin/node'
        self.put(node, 'synthetic node')
        records = {'status':'native-compilers-adopted-not-app-admitted'}
        pins = {'artifacts':{}}
        expected = preflight.load(self.payload/'inputs.template.json')['expectedCompilerSources']
        for profile, key in preflight.PROFILES.items():
            binary = self.root/'compilers'/profile/'bun'
            self.put(binary, 'synthetic compiler '+profile)
            records[key] = {'path':str(binary), 'sha256':preflight.sha(binary), 'bunCommit':expected['bun'],
                            'webkitCommit':expected['webkit'], 'engineFeatures':{'shadowRealm':profile=='standard','hardened':False}}
            pins['artifacts'][key] = {'compilerSha256':preflight.sha(binary)}
        self.put(self.root/'admission-inputs/compiler-records.json', records)
        self.put(self.payload.parent/'compiler-pins.json', pins)
        self.put(self.root/'admission-inputs/source-preparation.json', {'commit':self.commit})
        self.put(self.work/'execution.json', {'identity':{'repository':'openclaw/bun','job':'linux-x64-app','runId':'1','runAttempt':'1'},
                                            'sourceCommit':self.commit,'workflowHead':'3'*40,
                                            'variantSelection':'all','requestedVariants':['js','c2-off','ts']})
        self.put(self.root/'prep-receipts/plugins/result.json', {'status':'PASS','sourceCommit':self.commit,
            'nativeSource':{'commit':self.commit}, 'plugins':{'desktop.json':preflight.sha(selection)},
            'distBuildInfoSha256':preflight.sha(self.source/'dist/build-info.json'),
            'buildNode':{'path':str(node),'version':'26.12.1','sha256':preflight.sha(node)}})
        def git(args, **kwargs):
            if args[-2:] == ['rev-parse','HEAD']:return self.commit+'\n'
            if args[-2:] == ['rev-parse','HEAD^{tree}']:return self.tree+'\n'
            if 'status' in args:return ''
            raise AssertionError(args)
        self.mock_git = patch.object(preflight.subprocess,'check_output',side_effect=git)
        self.mock_git.start();self.addCleanup(self.mock_git.stop)

    def put(self, path, value):
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(json.dumps(value) if isinstance(value,(dict,list)) else value)

    def passing(self):
        inputs = preflight.snapshot(self.root,self.work,self.payload)
        directory = self.root/'prep-receipts/compatibility'
        for name in preflight.EXPORT_FILES:
            if name=='result.json':continue
            self.put(directory/name, {})
        for profile in preflight.PROFILES:
            self.put(directory/('selected-'+profile+'.json'), {'status':'passed','selectedMissing':[],
                        'unmappedWorkers':[],'undeclaredPluginWorkers':[]})
        result={'status':'PASS','nativeCompile':False,'profiles':list(preflight.PROFILES),'inputs':inputs,
                'steps':[{'name':name,'exitCode':0} for name in preflight.STEPS]}
        result['outputs']={name:preflight.sha(directory/name) for name in preflight.EXPORT_FILES if name!='result.json'}
        self.put(directory/'result.json',result)
        return directory,result

    def verify(self):
        return preflight.verify_completed(self.root,self.work,self.payload)

    def test_unbound_source_rejects_before_any_execution(self):
        unbound = dict(self.binding, status='awaiting-reviewed-r4-cut', sourceCommit=None, sourceTree=None)
        self.put(self.payload/'source-binding.json', unbound)
        with self.assertRaisesRegex(AssertionError,'Reviewed R4 source binding required'):
            preflight.snapshot(self.root,self.work,self.payload)

    def test_complete_native_pair_and_unchanged_inputs_are_required(self):
        self.passing()
        self.assertEqual(self.verify()['sourceCommit'],self.commit)
        records=preflight.load(self.root/'admission-inputs/compiler-records.json')
        records['cb-compat']['engineFeatures']['shadowRealm']=True
        self.put(self.root/'admission-inputs/compiler-records.json',records)
        with self.assertRaises(AssertionError):self.verify()

    def test_dist_and_selection_drift_block_admission(self):
        self.passing()
        self.put(self.source/'dist/main.js','import { registerHooks } from "node:module";')
        with self.assertRaisesRegex(AssertionError,'Compatibility input changed'):self.verify()
        self.put(self.source/'dist/main.js','export const main = 1;')
        self.put(self.root/'admission-inputs/plugins/desktop.json',['changed'])
        with self.assertRaises(AssertionError):self.verify()

    def test_mutated_or_missing_report_cannot_reuse_a_pass(self):
        directory,result=self.passing()
        (directory/'builtin-query-standard.json').unlink()
        with self.assertRaises(OSError):self.verify()
        self.put(directory/'builtin-query-standard.json',{})
        self.put(directory/'selected-standard.json',{'status':'failed'})
        with self.assertRaises(AssertionError):self.verify()

    def test_failed_projection_or_worker_omission_blocks_even_with_updated_hash(self):
        directory,result=self.passing()
        for key in ['selectedMissing','unmappedWorkers','undeclaredPluginWorkers']:
            selected={'status':'passed','selectedMissing':[],'unmappedWorkers':[],'undeclaredPluginWorkers':[]}
            selected[key]=[{'synthetic':'defect'}]
            path=directory/'selected-shadowrealm-off.json';self.put(path,selected)
            result['outputs'][path.name]=preflight.sha(path);self.put(directory/'result.json',result)
            with self.subTest(key=key),self.assertRaises(AssertionError):self.verify()

    def test_failed_command_and_incomplete_evidence_cannot_pass(self):
        directory,result=self.passing()
        result['steps'][-1]['exitCode']=1;self.put(directory/'result.json',result)
        with self.assertRaises(AssertionError):self.verify()
        result['steps'][-1]['exitCode']=0;result['outputs'].pop('node-identity.stdout')
        self.put(directory/'result.json',result)
        with self.assertRaisesRegex(AssertionError,'Complete preflight evidence'):self.verify()

    def test_helper_parser_and_source_owner_closure(self):
        self.passing()
        self.put(self.payload/'helpers/runtime.ts','changed')
        with self.assertRaises(AssertionError):self.verify()
        shutil.copyfile(HERE/'compatibility/helpers/runtime.ts',self.payload/'helpers/runtime.ts')
        parser=self.source/self.binding['typescript']['relativePath']
        self.put(parser/'lib/typescript.js','changed')
        with self.assertRaises(AssertionError):self.verify()

    def test_other_execution_cannot_reuse_receipt(self):
        self.passing()
        execution=preflight.load(self.work/'execution.json');execution['identity']['runId']='2'
        self.put(self.work/'execution.json',execution)
        with self.assertRaisesRegex(AssertionError,'Compatibility input changed'):self.verify()

    def test_admission_rejects_missing_compatibility_before_creating_output(self):
        spec=importlib.util.spec_from_file_location('app_admit',HERE/'admit.py')
        admit=importlib.util.module_from_spec(spec);spec.loader.exec_module(admit)
        with patch.object(admit,'ROOT',self.root),patch.object(sys,'argv',['admit.py','js']),\
             patch.dict(os.environ,{'P6_WORK':str(self.work)}),\
             patch.object(admit,'verify_completed',side_effect=AssertionError('preflight failed')):
            with self.assertRaisesRegex(AssertionError,'preflight failed'):admit.main()
        self.assertFalse((self.root/'admissions').exists())

    def test_exports_are_named_reports_without_state_trees(self):
        self.passing()
        names=[str(target) for _,target in preflight.export_selections(self.work,self.root)]
        self.assertIn('prep-receipts/compatibility/selected-standard.json',names)
        self.assertIn('prep-receipts/compatibility/result.json',names)
        self.assertFalse(any(part in name.split('/') for name in names for part in ['home','tmp','cache']))

    def run_synthetic_pipeline(self, failure=None, failure_code=1):
        calls=[]
        def bounded(command, **kwargs):
            args=command[3:]
            env=kwargs['env']
            if '-p' in args:
                name='node-identity' if args[0].endswith('/node') else 'identity-'+Path(args[0]).parent.name
                value={'platform':'linux','arch':'x64','version':'v26.12.1',
                       'bun':'150c9620c53710060186b8b0cd50985e035408b0',
                       'webkit':'aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8'}
            elif args[1].endswith('/scan.cjs'):
                name='full-dist-census';value={'records':[],'modules':[]}
                self.put(Path(env['PROBE_OUTPUT']),value)
            else:
                target=Path(args[-1]);name=target.stem
                value={'status':'passed','selectedMissing':[],'unmappedWorkers':[],
                       'undeclaredPluginWorkers':[]}
                if name==failure:value['selectedMissing']=[{'missing':['registerHooks']}]
                self.put(target,value)
            calls.append(name)
            kwargs['stdout'].write(json.dumps(value).encode())
            code=failure_code if name==failure else 0
            return SimpleNamespace(returncode=code),{'exitCode':code,'timedOut':False}
        spec=SimpleNamespace(loader=SimpleNamespace(exec_module=lambda _:None))
        owner=SimpleNamespace(run_bounded=bounded)
        with patch.object(preflight.platform,'system',return_value='Linux'),\
             patch.object(preflight.platform,'machine',return_value='x86_64'),\
             patch.dict(os.environ,{'P6_DEADLINE_EPOCH':str(time.time()+1000)}),\
             patch.object(preflight.importlib.util,'spec_from_file_location',return_value=spec),\
             patch.object(preflight.importlib.util,'module_from_spec',return_value=owner):
            code=preflight.run(self.root,self.work,self.payload)
        return code,calls

    def test_complete_pipeline_produces_reusable_receipt(self):
        code,calls=self.run_synthetic_pipeline()
        self.assertEqual(code,0)
        self.assertEqual(calls,preflight.STEPS)
        self.assertEqual(self.verify()['sourceCommit'],self.commit)

    def test_failed_first_profile_is_preserved_and_blocks_admission(self):
        code,calls=self.run_synthetic_pipeline('selected-standard')
        self.assertEqual(code,1)
        self.assertIn('selected-shadowrealm-off',calls)
        directory=self.root/'prep-receipts/compatibility'
        self.assertTrue((directory/'selected-standard.json').is_file())
        self.assertTrue((directory/'selected-shadowrealm-off.json').is_file())
        with self.assertRaises(AssertionError):self.verify()

    def test_deadline_stops_the_remaining_profiles(self):
        code,calls=self.run_synthetic_pipeline('builtin-query-standard',124)
        self.assertEqual(code,124)
        self.assertEqual(calls[-1],'builtin-query-standard')
        self.assertNotIn('builtin-query-shadowrealm-off',calls)
        self.assertEqual(preflight.load(self.root/'prep-receipts/compatibility/result.json')['status'],'FAIL')

    def test_paging_verifies_inside_owned_container_before_activation(self):
        binary=self.root/'bin';binary.mkdir(parents=True)
        log=self.root/'commands.jsonl'
        helper='#!'+sys.executable+'\n'+'''import json,os,sys
from pathlib import Path
with Path(os.environ['P6_TEST_LOG']).open('a') as out:
    out.write(json.dumps([Path(sys.argv[0]).name,*sys.argv[1:]])+'\\n')
raise SystemExit(7 if Path(sys.argv[0]).name=='docker' and sys.argv[1:2]==['exec'] else 0)
'''
        for name in ['docker','sudo']:
            (binary/name).write_text(helper);(binary/name).chmod(0o755)
        (binary/'timeout').write_text('#!/bin/sh\nwhile [ "$1" != docker ] && [ "$1" != sudo ]; do shift; done\nexec "$@"\n')
        (binary/'timeout').chmod(0o755)
        env={**os.environ,'PATH':str(binary)+':/usr/bin:/bin','P6_WORK':str(self.work),
             'P6_CONTAINER':'p6-fixture','P6_DEADLINE_EPOCH':str(int(time.time())+5000),
             'P6_TEST_LOG':str(log),'GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1',
             'GITHUB_REPOSITORY':'openclaw/bun','GITHUB_JOB':'linux-x64-app','GITHUB_SHA':'3'*40}
        done=subprocess.run(['/bin/bash',str(HERE/'host.sh'),'paging'],env=env,capture_output=True,text=True,timeout=5)
        calls=[json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual(done.returncode,7,done.stderr)
        self.assertTrue(any(call[:2]==['docker','exec'] and 'p6-fixture' in call and
                            '/p6-recipe/app/preflight.py' in call for call in calls))
        self.assertFalse(any('activate' in call for call in calls))


if __name__=='__main__':
    unittest.main()

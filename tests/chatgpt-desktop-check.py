"""Exercise the subscription plugin on signed DSH with a disposable Profile and synthetic OpenAI transport."""
import argparse
import json
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright
import official_desktop_check as desktop
from fresh_profile_fixture import fresh_test_home, initialize_fresh
from web_check import settings


def profile(home, fixture):
    path = home / 'dsh/profiles/desktop'
    path.mkdir(parents=True)
    initialize_fresh(fixture, home / 'dsh', path)
    docs = home / 'documents'
    docs.mkdir()
    (home / 'dsh/synthetic-plan.json').write_text('{}')
    (path / 'package.json').write_text(json.dumps({'name': 'synthetic-plan', 'private': True, 'dsh': {
        'profile': {'bundles': ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']}}}))
    (path / 'cordis.yml').write_text('[]\n')
    (path / 'pnpm-workspace.yaml').write_text('packages: ["."]\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    test_plugin = Path(__file__).with_name('fixtures') / 'chatgpt-plan.mjs'
    (path / 'cordis.patch.yml').write_text(f'- insert:\n    - id: synthetic-plan-transport\n      name: {json.dumps(str(test_plugin))}\n'
        f'- id: workspace-controller\n  config:\n    documentsDirectory: {docs}\n'
        '- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n'
        '  config:\n    provider: alcor-chatgpt\n    model: plan-test\n    reasoningEffort: ultra\n'
        '- id: session-telemetry-otel\n  disabled: true\n')
    return docs


def request(page, endpoint, **kwargs):
    return desktop.rpc(page, endpoint, {'request': kwargs})


def incomplete_login(page, launch):
    redirect = page.request.get(launch, max_redirects=0)
    assert redirect.status == 302
    params = parse_qs(urlsplit(redirect.headers['location']).query)
    callback = params['redirect_uri'][0] + '?' + urlencode({'state':params['state'][0], 'code':'fixture-private-code'})
    assert page.request.get(callback).status == 400


def login(page, home):
    begin = lambda: request(page, 'alcorChatgpt/beginLogin')['browserUrl']
    first = begin()
    assert urlsplit(first).hostname == '127.0.0.1'
    assert not request(page, 'alcorChatgpt/cancelLogin')['pending']
    incomplete_login(page, begin())
    state = request(page, 'alcorChatgpt/accountState')
    assert not state['pending'] and not state['activeId']
    response = page.request.get(begin(), max_redirects=0)
    assert response.status == 302
    url = urlsplit(response.headers['location'])
    assert url.netloc == 'auth.openai.com'
    params = parse_qs(url.query)
    assert params['client_id'] == ['dynamic_agent_client']
    assert params['code_challenge_method'] == ['S256']
    callback = params['redirect_uri'][0]
    assert urlsplit(callback).hostname == '127.0.0.1'
    (home / 'dsh/synthetic-plan.json').write_text(json.dumps({'nonce': params['nonce'][0], 'challenge': params['code_challenge'][0]}))
    response = page.request.get(callback + '?' + urlencode({'state': params['state'][0], 'code': 'synthetic', 'client_id': 'oaiapp_synthetic_dsh'}))
    assert response.ok, response.status
    state = request(page, 'alcorChatgpt/accountState')
    assert state['accounts'][0]['connected'] and state['activeId']


def model_catalog(page):
    catalog = desktop.rpc(page, 'session/modelCatalog')
    return json.dumps([group for group in catalog['groups'] if group['id'] == 'alcor-chatgpt'], ensure_ascii=False)


def check_login_control(page):
    dialog = settings(page)
    dialog.get_by_role('navigation').get_by_role('button', name=re.compile('^(Models?|模型)$')).click()
    button = dialog.get_by_role('button', name='Continue with ChatGPT')
    expect(button).to_be_visible()
    card = dialog.get_by_role('region', name='ChatGPT 套餐')
    card.screenshot(path=str(desktop.ARTIFACTS / 'chatgpt-disconnected.png'))
    # Capture the clicked launch URL without opening a real OpenAI authorization tab.
    page.evaluate("() => {window.savedOpen = window.open; window.open = url => {window.planLaunch = url; return null}}")
    try:
        button.click()
        expect(dialog.get_by_role('button', name='取消登录')).to_be_visible()
        assert urlsplit(page.evaluate('window.planLaunch')).hostname == '127.0.0.1'
        dialog.get_by_role('button', name='取消登录').click()
        expect(button).to_be_visible()
        assert not request(page, 'alcorChatgpt/accountState')['pending']

        # Exercise the error and retry controls using an incomplete synthetic registration.
        button.click()
        expect(dialog.get_by_role('button', name='取消登录')).to_be_visible()
        incomplete_login(page, page.evaluate('window.planLaunch'))
        expect(card.get_by_text(re.compile('回调信息不完整'))).to_be_visible()
        expect(button).to_be_enabled()
        card.screenshot(path=str(desktop.ARTIFACTS / 'chatgpt-login-error.png'))
        previous = page.viewport_size
        page.set_viewport_size({'width':540,'height':800})
        page.emulate_media(color_scheme='dark')
        assert card.evaluate('e => e.scrollWidth <= e.clientWidth + 1')
        card.screenshot(path=str(desktop.ARTIFACTS / 'chatgpt-narrow.png'))
        page.emulate_media(color_scheme='light')
        if previous:
            page.set_viewport_size(previous)
    finally:
        page.evaluate("() => {window.open = window.savedOpen; delete window.savedOpen; delete window.planLaunch}")
    page.keyboard.press('Escape')


def conversations(page, home, sessions, host_failure_check):
    def logged(event):
        path = home / 'dsh/synthetic-events'
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            if path.exists() and event in path.read_text().splitlines():
                return
            page.wait_for_timeout(100)
        result = request(page, 'session/projections', sessionId=session)
        raise AssertionError('Native chat did not reach ' + event + ' ' + json.dumps(result, ensure_ascii=False)[-3500:])

    for preset, session in sessions.items():
        opts = {'sessionId': session}
        # An existing Alcor profile can still have the legacy "ultra" default.
        if preset == 'standard':
            request(page, 'session/selectModel', **opts, provider='alcor-chatgpt', model='plan-test', reasoningEffort='max')
        def prompt(marker):
            request(page, 'session/prompt', **opts, requestId=str(uuid4()), mode='queue',
                    content=[{'type':'text','text':marker + '-' + preset}])
        prompt('TOOL')
        logged('result-TOOL-' + preset)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if 'Verified TOOL-' + preset in json.dumps(request(page, 'session/projections', **opts)):
                break
            page.wait_for_timeout(100)
        else:
            raise AssertionError('Native assistant response missing for ' + preset)
        prompt('STOP')
        logged('STOP-' + preset)
        request(page, 'session/cancel', **opts)
        logged('aborted-STOP-' + preset)
        if preset == 'alcor':
            prompt('REJECT')
            logged('invalid-effort')
            request(page, 'session/wait', **opts, timeoutMs=10000)
        if preset == 'standard':
            if host_failure_check:
                prompt('BADARGS')
                logged('result-BADARGS-standard')
                request(page, 'session/wait', **opts, timeoutMs=10000)
            prompt('LIMIT')
            logged('quota')
            request(page, 'session/wait', **opts, timeoutMs=10000)
            history = request(page, 'session/events', address={'kind':'session', **opts})
            assert '用量上限' in json.dumps(history, ensure_ascii=False), 'Native chat must surface the subscription limit'
            route = request(page, 'session/projections', **opts)['values']['modelSelection']
            assert route['next']['provider'] == 'alcor-chatgpt' and route['lastUsed']['provider'] == 'alcor-chatgpt'
        print('PASS', preset, 'existing chat, tool result, streamed reply and cancellation', flush=True)


def chatgpt_logs(page):
    records = request(page, 'alcorSecretary/logs', source='ChatGPT')['entries']
    expected = {
        'req_fixture_tool': ('info', 'plan-test', 'HTTP 200', 'ultra → max', '等待工具结果'),
        'req_fixture_answer': ('info', 'plan-test', 'HTTP 200', 'ultra → max'),
        'req_fixture_rejected': ('error', 'plan-test', 'HTTP 400', 'ultra → max', 'unsupported_reasoning_effort', '更换强度'),
        'req_fixture_catalog_1': ('error', 'HTTP 503', 'MODEL_CATALOG_FAILED', '重试'),
    }
    ids = {}
    for rid, (level, *fields) in expected.items():
        matches = [row for row in records if rid in row['message']]
        assert len(matches) == 1, f'Expected one ChatGPT log for {rid}, found {len(matches)}'
        row = matches[0]
        assert row['level'] == level and row['source'] == 'ChatGPT'
        assert all(field in row['message'] for field in fields), row['message']
        ids[rid] = row['id']
    callback = request(page, 'alcorSecretary/logs', source='ChatGPT', query='LOGIN_CALLBACK_INVALID')['entries']
    assert len(callback) == 1 and '重新' in callback[0]['message'], 'Expected an actionable login failure'
    ids['callback'] = callback[0]['id']
    messages = '\n'.join(row['message'] for row in records)
    for private in ['fixture-upstream-private', 'fixture-private-code', 'TOOL-alcor', 'REJECT-alcor',
                    'synthetic-access', 'synthetic-refresh']:
        assert private not in messages, 'A ChatGPT diagnostic exposed fixture content'
    return ids


def check_log_page(page):
    mode = page.get_by_role('button', name=re.compile(r'^切换使用模式，当前 '))
    if not mode.get_attribute('aria-label').endswith('Alcor'):
        mode.click()
        page.get_by_role('menuitem', name='Alcor', exact=True).click()
    page.get_by_role('group', name='系统', exact=True).get_by_role('button', name='日志', exact=True).click()
    panel = page.get_by_role('region', name='运行日志')
    panel.get_by_role('combobox', name='来源').select_option('ChatGPT')
    panel.get_by_role('combobox', name='类别').select_option('failure')
    panel.get_by_role('searchbox', name='搜索').fill('req_fixture_rejected')
    details = panel.get_by_role('listitem')
    expect(details).to_have_count(1)
    details.locator('summary').click()
    expect(details.locator('pre')).to_contain_text('HTTP 400')
    expect(details.locator('pre')).to_contain_text('ultra → max')
    expect(details.locator('pre')).to_contain_text('req_fixture_rejected')
    expect(details.locator('pre')).to_contain_text('更换强度')
    panel.screenshot(path=str(desktop.ARTIFACTS / 'chatgpt-runtime-log.png'))


def host_failure_log(page, session):
    rows = request(page, 'alcorSecretary/logs', source='DSH 对话', query='NO_ADAPTER')['entries']
    matches = [row for row in rows if session in row['message']]
    assert len(matches) == 1, 'Expected one searchable pre-step failure for this session'
    row = matches[0]
    assert row['level'] == 'error' and '重新选择' in row['message']
    assert 'fixture-host-failure-private' not in row['message'] and 'fixture-host-error-private' not in row['message']
    return row['id']


def tool_failure_log(page):
    call = 'ac520247-8ba4-4a50-b886-040d41244271'
    rows = request(page, 'alcorSecretary/logs', source='DSH 工具', query=call)['entries']
    assert len(rows) == 1, 'Expected one native tool failure for the rejected call'
    row = rows[0]
    assert row['level'] == 'error' and row['operation'] == 'tools.execute'
    assert 'INVALID_ARGS' in row['message'] and '核对' in row['message'], row['message']
    assert all(value not in row['message'] for value in ['BADARGS-standard', 'fixture-private-tool-argument',
                                                         'Tool execution failed.', 'invalid arguments:'])
    return row['id']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host-failure-check', action='store_true',
                        help='Also verify pre-dispatch diagnostics in an Alcor build with host failure logging.')
    parser.add_argument('archives', nargs=2, type=Path)
    args = parser.parse_args()
    desktop.verify_release()
    desktop.ARTIFACTS.mkdir(parents=True, exist_ok=True)
    original = desktop.environment
    desktop.environment = lambda home: {**original(home), 'PYTHONDONTWRITEBYTECODE': '1'}
    with fresh_test_home('alcor-plan-') as fixture, sync_playwright() as playwright:
        home = Path(fixture)
        docs = profile(home, fixture)
        secretary, plugin = [str(p.resolve(strict=True)) for p in args.archives]
        desktop.native_cli(home, 'plan-only-install', 'add', '--ignore-scripts', plugin)
        with desktop.desktop(playwright, home, 'subscription-only') as (page, errors):
            assert not request(page, 'alcorChatgpt/accountState')['accounts']
            check_login_control(page)
            assert not errors, errors
        desktop.native_cli(home, 'plan-secretary-install', 'add', '--ignore-scripts', secretary)
        with desktop.desktop(playwright, home, 'subscription') as (page, errors):
            assert not request(page, 'alcorChatgpt/accountState')['accounts']
            sessions = {preset: request(page, 'session/create', cwd=str(docs), agentPreset=preset)['sessionId']
                        for preset in ['alcor','standard']}
            login(page, home)
            # Simulate an unavailable catalog, then retry from the same connected account.
            outage = home / 'dsh/synthetic-catalog-unavailable'
            outage.touch()
            try:
                failures = desktop.rpc(page, 'session/modelCatalog')['failures']
                assert any(failure['id'] == 'alcor-chatgpt' for failure in failures)
            finally:
                outage.unlink()
            catalog = model_catalog(page)
            assert 'plan-test' in catalog and 'hidden-test' not in catalog
            assert 'ultra' not in catalog, 'The picker must hide unsupported Responses efforts'
            conversations(page, home, sessions, args.host_failure_check)
            if args.host_failure_check:
                tool_log = tool_failure_log(page)
                request(page, 'session/prompt', sessionId=sessions['standard'], requestId=str(uuid4()), mode='queue',
                        content=[{'type':'text', 'text':'fixture-host-failure-private'}])
                request(page, 'session/wait', sessionId=sessions['standard'], timeoutMs=10000)
                host_log = host_failure_log(page, sessions['standard'])
            saved_logs = chatgpt_logs(page)
            check_log_page(page)
            assert not errors, errors
        with desktop.desktop(playwright, home, 'subscription-restart') as (page, errors):
            state = request(page, 'alcorChatgpt/accountState')
            assert state['activeId'] and 'plan-test' in model_catalog(page)
            assert chatgpt_logs(page) == saved_logs, 'ChatGPT log entries must survive a Desktop restart'
            if args.host_failure_check:
                assert host_failure_log(page, sessions['standard']) == host_log
                assert tool_failure_log(page) == tool_log
                print('PASS pre-dispatch host and native tool failures, correlation, remedies, privacy and restart', flush=True)
            print('PASS login and catalog failure recovery, actionable HTTP 400, runtime log UI and restart', flush=True)
            assert not request(page, 'alcorChatgpt/signOut', accountId=state['activeId'])['activeId']
            remaining = model_catalog(page)
            assert 'plan-test' not in remaining, remaining
            assert not errors, errors
        print('PASS signed Desktop login, account model catalog, restart and logout', flush=True)


if __name__ == '__main__':
    main()

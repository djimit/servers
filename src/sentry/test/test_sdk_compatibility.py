import asyncio

import httpx
import pytest
from mcp.shared.exceptions import McpError
from mcp.types import INTERNAL_ERROR, INVALID_PARAMS

from mcp_server_sentry.server import handle_sentry_issue


def query(handler, issue="123"):
    async def run():
        async with httpx.AsyncClient(base_url="https://fixture.invalid/", transport=httpx.MockTransport(handler)) as client:
            return await handle_sentry_issue(client, "local-placeholder", issue)
    return asyncio.run(run())


def test_normal_issue_without_provider_requests():
    def handler(request):
        if request.url.path.endswith("/hashes/"):
            return httpx.Response(200, json=[{"latestEvent": {"entries": []}}])
        return httpx.Response(200, json={"title": "ordinary", "status": "resolved", "level": "info", "firstSeen": "2026-10-28", "lastSeen": "2026-10-28", "count": 1})
    assert query(handler).title == "ordinary"


@pytest.mark.parametrize("status,expected", [(401, "Unauthorized"), (500, "Error fetching Sentry issue")])
def test_provider_errors_remain_structured(status, expected):
    with pytest.raises(McpError, match=expected) as error:
        query(lambda request: httpx.Response(status))
    assert error.value.error.code == INTERNAL_ERROR


def test_missing_events_preserves_error():
    with pytest.raises(McpError, match="No Sentry events found") as error:
        query(lambda request: httpx.Response(200, json=[]))
    assert error.value.error.code == INTERNAL_ERROR


def test_invalid_issue_rejects_before_client_use():
    def unexpected(request):
        pytest.fail("invalid issue must not reach the transport")
    with pytest.raises(McpError, match="Missing issue_id_or_url") as error:
        query(unexpected, "")
    assert error.value.error.code == INVALID_PARAMS

import pytest
from pathlib import Path
import git
from mcp_server_git.server import git_checkout
import shutil

@pytest.fixture
def test_repository(tmp_path: Path):
    repo_path = tmp_path / "temp_test_repo"
    test_repo = git.Repo.init(repo_path)

    Path(repo_path / "test.txt").write_text("test")
    test_repo.index.add(["test.txt"])
    test_repo.index.commit("initial commit")

    yield test_repo

    shutil.rmtree(repo_path)

def test_git_checkout_existing_branch(test_repository):
    test_repository.git.branch("test-branch")
    result = git_checkout(test_repository, "test-branch")

    assert "Switched to branch 'test-branch'" in result
    assert test_repository.active_branch.name == "test-branch"

def test_git_checkout_nonexistent_branch(test_repository):

    with pytest.raises(git.GitCommandError):
        git_checkout(test_repository, "nonexistent-branch")

@pytest.mark.parametrize("patch", [b"ordinary patch", "ordinary patch", None])
def test_git_show_patch_representations(patch):
    from types import SimpleNamespace
    from typing import cast
    from mcp_server_git.server import git_show

    change = SimpleNamespace(a_path="a.txt", b_path="a.txt", diff=patch)
    parent = SimpleNamespace(diff=lambda *_args, **_kwargs: [change])
    commit = SimpleNamespace(
        hexsha="abc", author="ordinary author", authored_datetime="today",
        message="ordinary commit", parents=[parent],
    )
    repo = SimpleNamespace(commit=lambda _revision: commit)
    result = git_show(cast(git.Repo, repo), "HEAD")
    assert "--- a.txt\n+++ a.txt" in result
    assert result.endswith("ordinary patch" if patch is not None else "\n")


def test_git_show_real_commit(test_repository):
    from mcp_server_git.server import git_show

    result = git_show(test_repository, "HEAD")
    assert test_repository.head.commit.hexsha in result
    assert "test.txt" in result

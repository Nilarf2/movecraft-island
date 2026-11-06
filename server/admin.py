"""Command-line administration: python3 -m server.admin [--db PATH] COMMAND ...

  list-users [--hidden]        users with their round counts and totals
  reset-password NAME          sets a random password, prints it once, logs the user out everywhere
  hide NAME / unhide NAME      removes / restores the user on every leaderboard
  delete-user NAME --yes       deletes the user with saves, rounds and tokens
  backup [PATH] [--force]      consistent snapshot via the sqlite3 backup API
"""
import argparse
import os
from pathlib import Path
import secrets
import sqlite3
import sys
import time

from .security import Hasher, clean_username
from .store import Store, iso_time

ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no 0/o, 1/l/i


def find(store, name):
    try:
        _, key = clean_username(name)
    except Exception:
        key = str(name).casefold()
    row = store.one("SELECT id, username FROM users WHERE name_key = ?", (key,))
    if row is None:
        sys.exit(f"找不到用户：{name}")
    return row


def list_users(store, args):
    rows = store.all(
        "SELECT u.id, u.username, u.hidden, u.created_at, COUNT(r.id) AS rounds, COALESCE(SUM(r.total), 0) AS total "
        "FROM users u LEFT JOIN rounds r ON r.user_id = u.id "
        + ("WHERE u.hidden = 1 " if args.hidden else "") + "GROUP BY u.id ORDER BY u.id")
    print("id\tusername\thidden\trounds\ttotal\tcreated")
    for r in rows:
        print(f"{r['id']}\t{r['username']}\t{r['hidden']}\t{r['rounds']}\t{r['total']}\t{iso_time(r['created_at'])}")


def reset_password(store, args):
    user = find(store, args.name)
    password = "".join(secrets.choice(ALPHABET) for _ in range(10))
    digest = Hasher(n=int(os.environ.get("SCRYPT_N", 2 ** 14))).hash(password)
    with store.transaction() as db:
        db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (digest, user["id"]))
        db.execute("DELETE FROM tokens WHERE user_id = ?", (user["id"],))
    print(f"{user['username']} 的新密码：{password}")


def set_hidden(store, args, hidden):
    user = find(store, args.name)
    with store.transaction() as db:
        db.execute("UPDATE users SET hidden = ? WHERE id = ?", (hidden, user["id"]))
    print(f"{user['username']}：{'已隐藏' if hidden else '已恢复显示'}")


def delete_user(store, args):
    user = find(store, args.name)
    if not args.yes:
        sys.exit(f"会删除 {user['username']} 的账号、存档和全部成绩。确认请加 --yes")
    with store.transaction() as db:
        db.execute("DELETE FROM users WHERE id = ?", (user["id"],))
    print(f"已删除 {user['username']}")


def backup(store, args):
    target = Path(args.path) if args.path else (
        Path(store.path).parent / "backups" / time.strftime("movecraft-%Y%m%d-%H%M%S.sqlite3"))
    if target.exists() and not args.force:
        sys.exit(f"{target} 已存在，覆盖请加 --force")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    partial = target.with_name(target.name + ".part")
    out = sqlite3.connect(str(partial))
    try:
        with store.lock:
            store.db.backup(out)
    finally:
        out.close()
    os.chmod(partial, 0o600)
    os.replace(partial, target)
    print(target)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python3 -m server.admin", description="MoveCraft 账号服务管理")
    parser.add_argument("--db", default=os.environ.get("DB_PATH"), help="数据库路径，默认取 DB_PATH")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list-users").add_argument("--hidden", action="store_true", help="只列出被隐藏的")
    for name in ("reset-password", "hide", "unhide"):
        sub.add_parser(name).add_argument("name")
    delete = sub.add_parser("delete-user")
    delete.add_argument("name")
    delete.add_argument("--yes", action="store_true")
    snap = sub.add_parser("backup")
    snap.add_argument("path", nargs="?")
    snap.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    if not args.db:
        parser.error("请用 --db 或环境变量 DB_PATH 指定数据库")
    if not Path(args.db).is_file():
        sys.exit(f"数据库不存在：{args.db}")
    os.umask(0o077)
    store = Store(args.db)
    try:
        {"list-users": list_users, "reset-password": reset_password, "delete-user": delete_user,
         "backup": backup, "hide": lambda s, a: set_hidden(s, a, 1),
         "unhide": lambda s, a: set_hidden(s, a, 0)}[args.command](store, args)
    finally:
        store.close()


if __name__ == "__main__":
    main()

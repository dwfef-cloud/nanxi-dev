"""今日跟进 · Service 层

依赖 Repository 接口，不感知具体实现。
三段式待办：overdue（逾期）/ today（今天）/ upcoming（以后）。
"""
from datetime import datetime, timedelta, timezone

from app.models.domain import FollowUp
from app.repositories.base import Repository
from app.schemas.followup import FollowUpCreate

_CST = timezone(timedelta(hours=8))


class FollowUpService:
    def __init__(self, repo: Repository) -> None:
        self._repo = repo

    def list_followups(self, date: str | None = None) -> list[FollowUp]:
        """跟进待办列表

        date: 'overdue' / 'today' / 'upcoming' / None(全部)
        """
        return self._repo.list_followups(date=date)

    def create_followup(self, payload: FollowUpCreate) -> FollowUp:
        """新建跟进待办"""
        followup = FollowUp(
            customer_id=payload.customer_id,
            customer_name=payload.customer_name,
            type=payload.type,
            text=payload.text,
            due=payload.due,
            overdue=payload.overdue,
            done=False,
        )
        return self._repo.save_followup(followup)

    def complete_followup(self, followup_id: str, note: str | None = None) -> FollowUp:
        """标记完成（记录完成备注）"""
        followup = self._repo.get_followup(followup_id)
        followup.done = True
        if note:
            followup.result = note
        return self._repo.save_followup(followup)

    def delay_followup(self, followup_id: str, days: int = 1, due: str | None = None) -> FollowUp:
        """延期跟进：推迟 days 天，或显式指定新的截止时间文本"""
        followup = self._repo.get_followup(followup_id)
        if followup.done:
            raise ValueError("已完成的跟进不能延期")
        if due:
            followup.due = due
        else:
            target = datetime.now(_CST) + timedelta(days=days)
            followup.due = target.strftime("%m-%d %H:00")
        followup.overdue = False
        return self._repo.save_followup(followup)

    def update_followup(self, followup_id: str, payload) -> FollowUp:
        """编辑跟进：修改内容/类型/截止时间/状态（均可选）"""
        followup = self._repo.get_followup(followup_id)
        if payload.customer_name is not None:
            followup.customer_name = payload.customer_name
        if payload.type is not None:
            followup.type = payload.type
        if payload.text is not None:
            followup.text = payload.text
        if payload.due is not None:
            followup.due = payload.due
        if payload.done is not None:
            followup.done = payload.done
            if payload.done:
                followup.overdue = False
        return self._repo.save_followup(followup)

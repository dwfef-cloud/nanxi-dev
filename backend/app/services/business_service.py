from datetime import datetime, timezone

from app.models.domain import BusinessProfile
from app.repositories.memory import MemoryRepository
from app.schemas.business import BusinessProfileUpdate


class BusinessService:
    def __init__(self, repo: MemoryRepository) -> None:
        self._repo = repo

    def get_profile(self) -> BusinessProfile:
        return self._repo.get_business_profile()

    def update_profile(self, payload: BusinessProfileUpdate) -> BusinessProfile:
        """只保存业务画像自身（一物一源：产品归产品知识库、客户归目标客户，各自独立维护）。"""
        updated_at = datetime.now(timezone.utc)
        profile = BusinessProfile(**payload.model_dump(), updated_at=updated_at)
        return self._repo.save_business_profile(profile)

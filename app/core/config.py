from dotenv import load_dotenv
import os

load_dotenv()

class Settings:
    PROJECT_NAME: str = "AI Boardroom"
    ENVIRONMENT: str = os.getenv("ENVIRONMENT", "development")
    VOICE_AI_PUBLIC_KEY: str = os.getenv("VOICE_AI_PUBLIC_KEY", "")

settings = Settings()
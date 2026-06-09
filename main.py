#!/usr/bin/env python3
import asyncio
import aiohttp
import sys
from colorama import Fore, Style, init

init(autoreset=True)

class StripeChecker:
    def __init__(self):
        self.valid_found = asyncio.Event()
        self.session = None
        self.semaphore = asyncio.Semaphore(10)  # Concurrency limit
    
    async def check_key(self, key: str):
        if self.valid_found.is_set():
            return
        
        key = key.strip()
        if not key or not key.startswith("sk_"):
            return
        
        async with self.semaphore:
            try:
                async with self.session.get(
                    "https://api.stripe.com/v1/account",
                    headers={"Authorization": f"Bearer {key}"},
                    timeout=aiohttp.ClientTimeout(total=10)
                ) as response:
                    
                    if response.status == 200:
                        data = await response.json()
                        email = data.get("email", "N/A")
                        country = data.get("country", "N/A")
                        charges_enabled = data.get("charges_enabled", False)
                        
                        print(f"\n{Fore.GREEN}[VALID]{Style.RESET_ALL}")
                        print(f"{Fore.GREEN}{key[:12]}... is valid!{Style.RESET_ALL}")
                        print(f"Email: {email}")
                        print(f"Country: {country}")
                        print(f"Charges Enabled: {charges_enabled}")
                        
                        self.valid_found.set()
                        return True
                    else:
                        print(f"{Fore.RED}[INVALID]{Style.RESET_ALL} {key[:12]}...")
                        
            except Exception:
                print(f"{Fore.RED}[INVALID]{Style.RESET_ALL} {key[:12]}...")
            
            return False
    
    async def run(self, filename: str = "keys.txt"):
        try:
            with open(filename, "r") as f:
                keys = [line.strip() for line in f if line.strip()]
        except FileNotFoundError:
            print(f"{Fore.RED}Error: {filename} not found{Style.RESET_ALL}")
            sys.exit(1)
        
        print(f"Loaded {len(keys)} keys. Checking...\n")
        
        connector = aiohttp.TCPConnector(limit=100, limit_per_host=50)
        timeout = aiohttp.ClientTimeout(total=30)
        
        async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
            self.session = session
            tasks = [self.check_key(key) for key in keys]
            await asyncio.gather(*tasks)
        
        if not self.valid_found.is_set():
            print(f"\n{Fore.RED}No valid keys found.{Style.RESET_ALL}")

if __name__ == "__main__":
    checker = StripeChecker()
    asyncio.run(checker.run())

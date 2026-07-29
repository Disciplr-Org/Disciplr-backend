import os

files = [
    'src/middleware/auth.ts', 
    'src/middleware/auth.middleware.ts', 
    'src/middleware/userAuth.ts'
]

for filepath in files:
    print(f'\\n========== {filepath} ==========')
    if os.path.exists(filepath):
        with open(filepath, 'r', encoding='utf-8') as f:
            print(f.read())
    else:
        print('FILE NOT FOUND')

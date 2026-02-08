git pull
npm install

npm test
if [ $? -ne 0 ]; then
  echo "Tests failed, aborting deployment"
  exit 1
fi

npm run build
npm run typeorm:generate -- "migrations/hehexd" -d ormconfig.js
npm run build
npm run typeorm:migrate -- -d ormconfig.js
pm2 reload "shado-cloud-backend" --update-env
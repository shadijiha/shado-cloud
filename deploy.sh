git pull
npm install
npm run build
npm run typeorm:generate -- "migrations/hehexd" -d ormconfig.js
npm run build
npm run typeorm:migrate -- -d ormconfig.js
pm2 reload "shado-cloud-backend" --update-env
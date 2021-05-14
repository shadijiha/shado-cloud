<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class TemporaryUrlsToUploadedFileTable extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        Schema::table('uploaded_files', function (Blueprint $table) {
            $table->integer('user_id')->nullable()->change();
            $table->string("temporary_url")->nullable();
            $table->timestamp("url_expires_at")->nullable();
        });
    }

    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        Schema::table('uploaded_files', function (Blueprint $table) {
            $table->string("user_id")->change();
            $table->dropColumn("temporary_url");
            $table->dropColumn("url_expires_at");
        });
    }
}

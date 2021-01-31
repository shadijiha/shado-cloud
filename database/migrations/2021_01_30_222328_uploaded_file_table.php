<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class UploadedFileTable extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        Schema::create('uploaded_files', function (Blueprint $table) {
            $table->id();
            $table->integer('user_id');
            $table->string('path');
            $table->string('mime_type');
            $table->timestamp('updated_at')->nullable();
            $table->timestamp('created_at')->nullable();
        });
    }

    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        //
        Schema::drop('uploaded_files');
    }
}

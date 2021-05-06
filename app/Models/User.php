<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Illuminate\Support\Collection;

/**
 * Class UploadedFile
 * @package App\Models
 * @mixin Builder
 */
class User extends Authenticatable
{
    use HasFactory, Notifiable;

    /**
     * The attributes that are mass assignable.
     *
     * @var array
     */
    protected $fillable = [
        'name',
        'email',
        'password',
    ];

    /**
     * The attributes that should be hidden for arrays.
     *
     * @var array
     */
    protected $hidden = [
        'password',
        'remember_token',
    ];

    /**
     * The attributes that should be cast to native types.
     *
     * @var array
     */
    protected $casts = [
        'email_verified_at' => 'datetime',
    ];

    /**
     *
     */
    public function apiTokens()
    {
        return $this->hasMany(APIToken::class);
    }

    /**
     * Gets all user's valid API tokens
     * @return Collection
     */
    public function validAPITokens(): Collection
    {
        $collection = new Collection();
        foreach (APIToken::all() as $token) {
            if ($token->isValid() && $token->user_id == $this->id) {
                $collection->add($token);
            }
        }

        return $collection;
    }

    /**
     * @return HasMany
     */
    public function uploadedFiles()
    {
        return $this->hasMany(UploadedFile::class);
    }
}
